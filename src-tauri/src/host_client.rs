use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::LazyLock,
    time::Duration,
};

use chrono::Utc;
use futures::{StreamExt, stream};
use remote_protocol::{DeviceCredential, RedeemPairingRequest, ServerCapabilities};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use url::Url;
use uuid::Uuid;

use crate::{
    error::AppError,
    remote_desktop::{RemoteDesktopRegistry, validate_base_url},
};

pub const ACTIVE_PROFILE_ID: &str = "active-host-client";
const STORE_FILE_NAME: &str = "host-client-profiles.json";
const DEFAULT_PORT: u16 = 17891;
const DISCOVERY_TIMEOUT: Duration = Duration::from_millis(400);
const NEEDS_TOKEN: &str = "needs_token";

static RUNTIME: LazyLock<HostClientRuntime> = LazyLock::new(HostClientRuntime::new);

pub fn runtime() -> &'static HostClientRuntime {
    &RUNTIME
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct StoredState {
    #[serde(default)]
    active_profile_id: Option<String>,
    #[serde(default)]
    profiles: Vec<StoredProfile>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct StoredProfile {
    id: String,
    origin: String,
    #[serde(default)]
    host_id: Option<String>,
    #[serde(default)]
    name: String,
    #[serde(default)]
    device_id: Option<String>,
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    last_connected_at: Option<String>,
    #[serde(default)]
    needs_token: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct HostClientProfileView {
    pub id: String,
    pub origin: String,
    pub host_id: Option<String>,
    pub name: String,
    pub last_connected_at: Option<String>,
    pub needs_token: bool,
    pub has_credential: bool,
    pub connected: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct DiscoveredHost {
    pub origin: String,
    pub host_id: Option<String>,
    pub name: Option<String>,
    pub saved: bool,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ConnectHostRequest {
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub profile_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ConnectHostResult {
    pub profile: HostClientProfileView,
    pub stopped_host: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct HostClientStatus {
    pub connected: bool,
    pub profile: Option<HostClientProfileView>,
    pub profiles: Vec<HostClientProfileView>,
}

#[derive(Clone, Debug, Deserialize)]
struct HealthBody {
    status: Option<String>,
    ok: Option<bool>,
    host_id: Option<String>,
    name: Option<String>,
}

#[derive(Clone)]
struct ActiveClient {
    profile_id: String,
}

pub struct HostClientRuntime {
    path: PathBuf,
    client: reqwest::Client,
    probe_client: reqwest::Client,
    active: Mutex<Option<ActiveClient>>,
    local_host_id: Mutex<Option<String>>,
}

impl HostClientRuntime {
    pub fn new() -> Self {
        Self::with_path(utils::assets::asset_dir().join(STORE_FILE_NAME))
    }

    pub fn with_path(path: PathBuf) -> Self {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        Self {
            path,
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(15))
                .build()
                .expect("host client http"),
            probe_client: reqwest::Client::builder()
                .connect_timeout(DISCOVERY_TIMEOUT)
                .timeout(DISCOVERY_TIMEOUT)
                .build()
                .expect("host client probe http"),
            active: Mutex::new(None),
            local_host_id: Mutex::new(None),
        }
    }

    pub async fn set_local_host_id(&self, host_id: Option<String>) {
        *self.local_host_id.lock().await = host_id.filter(|value| !value.is_empty());
    }

    pub async fn status(
        &self,
        registry: &RemoteDesktopRegistry,
    ) -> Result<HostClientStatus, AppError> {
        self.refresh_active(registry).await?;
        let state = self.load().await?;
        let active_id = self
            .active
            .lock()
            .await
            .as_ref()
            .map(|item| item.profile_id.clone());
        let profiles = views(&state, active_id.as_deref());
        let profile = active_id
            .as_deref()
            .and_then(|id| profiles.iter().find(|item| item.id == id).cloned());
        Ok(HostClientStatus {
            connected: profile.is_some(),
            profile,
            profiles,
        })
    }

    pub async fn discover(&self) -> Result<Vec<DiscoveredHost>, AppError> {
        let saved = self.load().await?;
        let skip_host_id = self.local_host_id.lock().await.clone();
        let own_ips: Vec<_> = utils::net::lan_ipv4_addrs()
            .into_iter()
            .map(|ip| ip.to_string())
            .collect();
        let candidates = utils::net::lan_probe_ipv4s();
        let probe = self.probe_client.clone();
        let probed: Vec<_> = stream::iter(candidates)
            .map(move |ip| {
                let probe = probe.clone();
                async move { probe_origin_with(&probe, format!("http://{ip}:{DEFAULT_PORT}")).await }
            })
            .buffer_unordered(48)
            .collect()
            .await;
        let mut found = Vec::new();
        let mut seen = HashSet::new();
        for result in probed {
            let Some(host) = result else {
                continue;
            };
            if own_ips.iter().any(|ip| host.origin.contains(ip)) {
                continue;
            }
            if skip_host_id
                .as_ref()
                .is_some_and(|id| host.host_id.as_ref() == Some(id))
            {
                continue;
            }
            let key = host.host_id.clone().unwrap_or_else(|| host.origin.clone());
            if !seen.insert(key) {
                continue;
            }
            found.push(host);
        }
        found.sort_by(|left, right| left.origin.cmp(&right.origin));
        Ok(found
            .into_iter()
            .map(|host| DiscoveredHost {
                saved: saved
                    .profiles
                    .iter()
                    .any(|profile| same_host(profile, host.host_id.as_deref(), &host.origin)),
                origin: host.origin,
                host_id: host.host_id,
                name: host.name,
            })
            .collect())
    }

    pub async fn connect(
        &self,
        window_label: &str,
        registry: &RemoteDesktopRegistry,
        request: ConnectHostRequest,
        stop_host: impl std::future::Future<Output = bool>,
    ) -> Result<ConnectHostResult, AppError> {
        let mut state = self.load().await?;
        let selected = request
            .profile_id
            .as_deref()
            .and_then(|id| state.profiles.iter().find(|profile| profile.id == id))
            .cloned();
        let origin = normalize_origin(
            request
                .origin
                .as_deref()
                .or(selected.as_ref().map(|profile| profile.origin.as_str()))
                .unwrap_or(""),
        )?;
        let supplied_token = request
            .token
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        let stored_token = selected
            .as_ref()
            .and_then(|profile| profile.access_token.clone())
            .filter(|value| !value.is_empty());
        let device_name = local_device_name();

        let credential = if let Some(token) = supplied_token {
            match obtain_device_credential(&self.client, &origin, token, &device_name).await {
                Ok(credential) => credential,
                Err(error) if is_needs_token(&error) => {
                    if let Some(profile) = selected.as_ref() {
                        mark_needs_token(&mut state, &profile.id);
                        self.save(&state).await?;
                    }
                    return Err(error);
                }
                Err(error) => return Err(error),
            }
        } else if let Some(token) = stored_token {
            match verify_device_token(&self.client, &origin, &token).await {
                Ok(_) => DeviceCredentialParts {
                    device_id: selected
                        .as_ref()
                        .and_then(|profile| profile.device_id.clone()),
                    access_token: token,
                },
                Err(error) if is_needs_token(&error) => {
                    if let Some(profile) = selected.as_ref() {
                        mark_needs_token(&mut state, &profile.id);
                        self.save(&state).await?;
                    }
                    return Err(error);
                }
                Err(error) => return Err(error),
            }
        } else {
            return Err(AppError::BadRequest(NEEDS_TOKEN.to_string()));
        };

        let capabilities = fetch_capabilities(&self.client, &origin, &credential.access_token)
            .await
            .map_err(|error| {
                if is_needs_token(&error) {
                    AppError::BadRequest(NEEDS_TOKEN.to_string())
                } else {
                    error
                }
            })?;
        let host_id = empty_to_none(capabilities.host_id);
        let name = discover_name(&self.client, &origin)
            .await
            .or_else(|| selected.as_ref().map(|profile| profile.name.clone()))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| origin.clone());

        let stopped_host = stop_host.await;
        registry.disconnect_profile(ACTIVE_PROFILE_ID).await;
        registry
            .connect(
                window_label,
                ACTIVE_PROFILE_ID,
                &origin,
                credential.access_token.clone(),
            )
            .await?;

        let now = Utc::now().to_rfc3339();
        let profile_id = upsert_profile(
            &mut state,
            selected.as_ref().map(|profile| profile.id.as_str()),
            origin,
            host_id,
            name,
            credential,
            now,
        );
        state.active_profile_id = Some(profile_id.clone());
        self.save(&state).await?;
        *self.active.lock().await = Some(ActiveClient {
            profile_id: profile_id.clone(),
        });

        let views = views(&state, Some(&profile_id));
        let profile = views
            .into_iter()
            .find(|item| item.id == profile_id)
            .expect("connected profile");
        Ok(ConnectHostResult {
            profile,
            stopped_host,
        })
    }

    pub async fn disconnect(&self, registry: &RemoteDesktopRegistry) -> Result<(), AppError> {
        registry.disconnect_profile(ACTIVE_PROFILE_ID).await;
        *self.active.lock().await = None;
        let mut state = self.load().await?;
        state.active_profile_id = None;
        self.save(&state).await?;
        Ok(())
    }

    pub async fn delete(
        &self,
        registry: &RemoteDesktopRegistry,
        profile_id: &str,
    ) -> Result<(), AppError> {
        let mut state = self.load().await?;
        let Some(index) = state
            .profiles
            .iter()
            .position(|profile| profile.id == profile_id)
        else {
            return Err(AppError::NotFound("saved Host was not found".to_string()));
        };
        let removed = state.profiles.remove(index);
        if self
            .active
            .lock()
            .await
            .as_ref()
            .is_some_and(|active| active.profile_id == profile_id)
        {
            registry.disconnect_profile(ACTIVE_PROFILE_ID).await;
            *self.active.lock().await = None;
            state.active_profile_id = None;
        }
        self.save(&state).await?;
        if let (Some(device_id), Some(token)) = (removed.device_id, removed.access_token) {
            let _ = revoke_remote_device(&self.client, &removed.origin, &device_id, &token).await;
        }
        Ok(())
    }

    async fn refresh_active(&self, registry: &RemoteDesktopRegistry) -> Result<(), AppError> {
        let active_id = self
            .active
            .lock()
            .await
            .as_ref()
            .map(|item| item.profile_id.clone());
        let Some(profile_id) = active_id else {
            return Ok(());
        };
        let mut state = self.load().await?;
        let Some(profile) = state
            .profiles
            .iter()
            .find(|profile| profile.id == profile_id)
            .cloned()
        else {
            registry.disconnect_profile(ACTIVE_PROFILE_ID).await;
            *self.active.lock().await = None;
            return Ok(());
        };
        let Some(token) = profile.access_token.clone() else {
            self.forget_active(registry, &mut state, &profile_id)
                .await?;
            return Ok(());
        };
        match verify_device_token(&self.client, &profile.origin, &token).await {
            Ok(_) => Ok(()),
            Err(error) if is_needs_token(&error) => {
                mark_needs_token(&mut state, &profile_id);
                self.forget_active(registry, &mut state, &profile_id)
                    .await?;
                Err(AppError::BadRequest(NEEDS_TOKEN.to_string()))
            }
            Err(_) => {
                self.forget_active(registry, &mut state, &profile_id)
                    .await?;
                Ok(())
            }
        }
    }

    async fn forget_active(
        &self,
        registry: &RemoteDesktopRegistry,
        state: &mut StoredState,
        profile_id: &str,
    ) -> Result<(), AppError> {
        registry.disconnect_profile(ACTIVE_PROFILE_ID).await;
        *self.active.lock().await = None;
        if state.active_profile_id.as_deref() == Some(profile_id) {
            state.active_profile_id = None;
        }
        self.save(state).await
    }

    async fn load(&self) -> Result<StoredState, AppError> {
        if !self.path.exists() {
            return Ok(StoredState::default());
        }
        let bytes = tokio::fs::read(&self.path).await.map_err(internal)?;
        serde_json::from_slice(&bytes).map_err(internal)
    }

    async fn save(&self, state: &StoredState) -> Result<(), AppError> {
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(internal)?;
        }
        let encoded = serde_json::to_vec_pretty(state).map_err(internal)?;
        tokio::fs::write(&self.path, encoded)
            .await
            .map_err(internal)?;
        restrict_store(&self.path);
        Ok(())
    }
}

async fn probe_origin_with(client: &reqwest::Client, origin: String) -> Option<DiscoveredProbe> {
    let url = format!("{origin}/health");
    let response = client.get(url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body = response.json::<HealthBody>().await.ok()?;
    parse_health(&origin, body)
}

struct DiscoveredProbe {
    origin: String,
    host_id: Option<String>,
    name: Option<String>,
}

struct DeviceCredentialParts {
    device_id: Option<String>,
    access_token: String,
}

fn parse_health(origin: &str, body: HealthBody) -> Option<DiscoveredProbe> {
    let ok = body.status.as_deref() == Some("ok") || body.ok == Some(true);
    if !ok {
        return None;
    }
    Some(DiscoveredProbe {
        origin: origin.trim_end_matches('/').to_string(),
        host_id: empty_to_none(body.host_id.unwrap_or_default()),
        name: empty_to_none(body.name.unwrap_or_default()),
    })
}

fn views(state: &StoredState, active_id: Option<&str>) -> Vec<HostClientProfileView> {
    let mut profiles: Vec<_> = state
        .profiles
        .iter()
        .map(|profile| HostClientProfileView {
            id: profile.id.clone(),
            origin: profile.origin.clone(),
            host_id: profile.host_id.clone(),
            name: if profile.name.is_empty() {
                profile.origin.clone()
            } else {
                profile.name.clone()
            },
            last_connected_at: profile.last_connected_at.clone(),
            needs_token: profile.needs_token || profile.access_token.is_none(),
            has_credential: profile.access_token.is_some() && !profile.needs_token,
            connected: active_id == Some(profile.id.as_str()),
        })
        .collect();
    profiles.sort_by(|left, right| {
        right
            .connected
            .cmp(&left.connected)
            .then(right.last_connected_at.cmp(&left.last_connected_at))
            .then(left.name.cmp(&right.name))
    });
    profiles
}

fn upsert_profile(
    state: &mut StoredState,
    selected_id: Option<&str>,
    origin: String,
    host_id: Option<String>,
    name: String,
    credential: DeviceCredentialParts,
    now: String,
) -> String {
    let existing_index = selected_id
        .and_then(|id| state.profiles.iter().position(|profile| profile.id == id))
        .or_else(|| {
            state
                .profiles
                .iter()
                .position(|profile| same_host(profile, host_id.as_deref(), &origin))
        });
    if let Some(index) = existing_index {
        let profile = &mut state.profiles[index];
        profile.origin = origin;
        if host_id.is_some() {
            profile.host_id = host_id;
        }
        profile.name = name;
        profile.device_id = credential.device_id.or(profile.device_id.clone());
        profile.access_token = Some(credential.access_token);
        profile.last_connected_at = Some(now);
        profile.needs_token = false;
        return profile.id.clone();
    }
    let id = Uuid::new_v4().to_string();
    state.profiles.push(StoredProfile {
        id: id.clone(),
        origin,
        host_id,
        name,
        device_id: credential.device_id,
        access_token: Some(credential.access_token),
        last_connected_at: Some(now),
        needs_token: false,
    });
    id
}

fn mark_needs_token(state: &mut StoredState, profile_id: &str) {
    if let Some(profile) = state
        .profiles
        .iter_mut()
        .find(|profile| profile.id == profile_id)
    {
        profile.access_token = None;
        profile.device_id = None;
        profile.needs_token = true;
    }
}

fn same_host(profile: &StoredProfile, host_id: Option<&str>, origin: &str) -> bool {
    if let (Some(saved), Some(found)) = (profile.host_id.as_deref(), host_id) {
        return saved == found;
    }
    profile.origin == origin
}

fn normalize_origin(value: &str) -> Result<String, AppError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(AppError::BadRequest("Host address is required".to_string()));
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let mut url = Url::parse(&with_scheme)
        .map_err(|error| AppError::BadRequest(format!("invalid Host address: {error}")))?;
    if url.scheme() == "http"
        && url.port().is_none()
        && !trimmed.contains(":80")
        && url.host_str().is_some_and(utils::net::is_trusted_http_host)
    {
        url.set_port(Some(DEFAULT_PORT))
            .map_err(|_| AppError::BadRequest("invalid Host address".to_string()))?;
    }
    validate_base_url(url.as_str())
}

async fn obtain_device_credential(
    client: &reqwest::Client,
    origin: &str,
    token: &str,
    device_name: &str,
) -> Result<DeviceCredentialParts, AppError> {
    let pairing_token = pairing_token_from_input(token);
    if !remote_protocol::is_connection_code(&pairing_token) {
        return Err(AppError::BadRequest(NEEDS_TOKEN.to_string()));
    }
    redeem(client, origin, &pairing_token, device_name).await
}

fn pairing_token_from_input(token: &str) -> String {
    let trimmed = token.trim();
    if let Some(payload) = trimmed.strip_prefix("vibex-pairing:")
        && let Ok(value) = serde_json::from_str::<serde_json::Value>(payload)
        && let Some(code) = value.get("pairing_token").and_then(|item| item.as_str())
    {
        return code.to_string();
    }
    trimmed.to_string()
}

async fn redeem(
    client: &reqwest::Client,
    origin: &str,
    pairing_token: &str,
    device_name: &str,
) -> Result<DeviceCredentialParts, AppError> {
    let response = client
        .post(format!("{origin}/api/v1/auth/pairings/redeem"))
        .header(
            "x-vibex-protocol-version",
            remote_protocol::PROTOCOL_VERSION,
        )
        .json(&RedeemPairingRequest {
            pairing_token: pairing_token.to_string(),
            device_name: device_name.to_string(),
        })
        .send()
        .await
        .map_err(reachability)?;
    if !response.status().is_success() {
        return Err(AppError::BadRequest(NEEDS_TOKEN.to_string()));
    }
    let credential = response
        .json::<DeviceCredential>()
        .await
        .map_err(internal)?;
    Ok(DeviceCredentialParts {
        device_id: Some(credential.device_id.to_string()),
        access_token: credential.access_token,
    })
}

async fn verify_device_token(
    client: &reqwest::Client,
    origin: &str,
    token: &str,
) -> Result<ServerCapabilities, AppError> {
    fetch_capabilities(client, origin, token).await
}

async fn fetch_capabilities(
    client: &reqwest::Client,
    origin: &str,
    token: &str,
) -> Result<ServerCapabilities, AppError> {
    let response = client
        .get(format!("{origin}/api/v1/capabilities"))
        .bearer_auth(token)
        .header(
            "x-vibex-protocol-version",
            remote_protocol::PROTOCOL_VERSION,
        )
        .send()
        .await
        .map_err(reachability)?;
    if response.status().as_u16() == 401 || response.status().as_u16() == 403 {
        return Err(AppError::BadRequest(NEEDS_TOKEN.to_string()));
    }
    if !response.status().is_success() {
        return Err(AppError::Internal(format!(
            "remote Server returned HTTP {}",
            response.status()
        )));
    }
    response.json().await.map_err(internal)
}

async fn discover_name(client: &reqwest::Client, origin: &str) -> Option<String> {
    let response = client.get(format!("{origin}/health")).send().await.ok()?;
    let body = response.json::<HealthBody>().await.ok()?;
    empty_to_none(body.name.unwrap_or_default())
}

async fn revoke_remote_device(
    client: &reqwest::Client,
    origin: &str,
    device_id: &str,
    token: &str,
) -> Result<(), AppError> {
    let response = client
        .delete(format!("{origin}/api/v1/auth/devices/{device_id}"))
        .bearer_auth(token)
        .header(
            "x-vibex-protocol-version",
            remote_protocol::PROTOCOL_VERSION,
        )
        .send()
        .await
        .map_err(reachability)?;
    if response.status().is_success() || response.status().as_u16() == 401 {
        return Ok(());
    }
    Ok(())
}

fn local_device_name() -> String {
    utils::net::local_hostname()
        .map(|name| format!("VibeX ({name})"))
        .unwrap_or_else(|| "VibeX Workstation".to_string())
        .chars()
        .take(128)
        .collect()
}

fn empty_to_none(value: String) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn is_needs_token(error: &AppError) -> bool {
    matches!(error, AppError::BadRequest(message) if message == NEEDS_TOKEN)
}

fn reachability(error: reqwest::Error) -> AppError {
    AppError::BadRequest(format!("could not reach Host: {error}"))
}

fn internal(error: impl std::fmt::Display) -> AppError {
    AppError::Internal(error.to_string())
}

fn restrict_store(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}

#[cfg(test)]
mod tests {
    use super::{
        HealthBody, HostClientRuntime, StoredProfile, StoredState, normalize_origin,
        pairing_token_from_input, parse_health, upsert_profile, views,
    };
    use crate::host_client::DeviceCredentialParts;

    #[test]
    fn health_requires_ok_status() {
        assert!(
            parse_health(
                "http://192.168.1.8:17891",
                HealthBody {
                    status: Some("ok".into()),
                    ok: None,
                    host_id: Some("host-1".into()),
                    name: Some("Studio".into()),
                }
            )
            .is_some()
        );
        assert!(
            parse_health(
                "http://192.168.1.8:17891",
                HealthBody {
                    status: Some("down".into()),
                    ok: None,
                    host_id: None,
                    name: None,
                }
            )
            .is_none()
        );
    }

    #[test]
    fn pairing_input_accepts_invitation_payloads() {
        assert_eq!(
            pairing_token_from_input(r#"vibex-pairing:{"pairing_token":"K7M2NPQX","host_id":"h"}"#),
            "K7M2NPQX"
        );
        assert_eq!(pairing_token_from_input(" K7M2NPQX "), "K7M2NPQX");
    }

    #[test]
    fn saved_views_pin_the_connected_host_and_hide_tokens() {
        let state = StoredState {
            active_profile_id: Some("b".into()),
            profiles: vec![
                StoredProfile {
                    id: "a".into(),
                    origin: "http://192.168.1.8:17891".into(),
                    host_id: Some("host-a".into()),
                    name: "Alpha".into(),
                    device_id: Some("dev-a".into()),
                    access_token: Some("secret-a".into()),
                    last_connected_at: Some("2026-08-01T00:00:00Z".into()),
                    needs_token: false,
                },
                StoredProfile {
                    id: "b".into(),
                    origin: "http://192.168.1.9:17891".into(),
                    host_id: Some("host-b".into()),
                    name: "Beta".into(),
                    device_id: Some("dev-b".into()),
                    access_token: Some("secret-b".into()),
                    last_connected_at: Some("2026-08-02T00:00:00Z".into()),
                    needs_token: false,
                },
            ],
        };
        let encoded = serde_json::to_string(&views(&state, Some("b"))).expect("json");
        assert!(!encoded.contains("secret-"));
        let profiles = views(&state, Some("b"));
        assert_eq!(profiles[0].id, "b");
        assert!(profiles[0].connected);
        assert!(profiles[0].has_credential);
        assert!(!profiles[0].needs_token);
    }

    #[test]
    fn upsert_reuses_the_same_host_id() {
        let mut state = StoredState::default();
        let first = upsert_profile(
            &mut state,
            None,
            "http://192.168.1.8:17891".into(),
            Some("host-1".into()),
            "Studio".into(),
            DeviceCredentialParts {
                device_id: Some("dev-1".into()),
                access_token: "token-1".into(),
            },
            "2026-08-20T00:00:00Z".into(),
        );
        let second = upsert_profile(
            &mut state,
            None,
            "http://192.168.1.8:19000".into(),
            Some("host-1".into()),
            "Studio".into(),
            DeviceCredentialParts {
                device_id: Some("dev-2".into()),
                access_token: "token-2".into(),
            },
            "2026-08-20T01:00:00Z".into(),
        );
        assert_eq!(first, second);
        assert_eq!(state.profiles.len(), 1);
        assert_eq!(state.profiles[0].origin, "http://192.168.1.8:19000");
        assert_eq!(state.profiles[0].access_token.as_deref(), Some("token-2"));
    }

    #[test]
    fn lan_http_origins_default_to_the_host_port() {
        assert_eq!(
            normalize_origin("192.168.1.8").expect("origin"),
            "http://192.168.1.8:17891"
        );
        assert_eq!(
            normalize_origin("http://10.0.0.4:19000").expect("origin"),
            "http://10.0.0.4:19000"
        );
    }

    #[tokio::test]
    async fn store_round_trip_does_not_create_a_file_until_save() {
        let dir = tempfile::tempdir().expect("tempdir");
        let runtime = HostClientRuntime::with_path(dir.path().join("profiles.json"));
        let status = runtime
            .status(&crate::remote_desktop::RemoteDesktopRegistry::new().expect("registry"))
            .await
            .expect("status");
        assert!(!status.connected);
        assert!(status.profiles.is_empty());
    }

    #[tokio::test]
    async fn first_token_is_remembered_until_the_host_revokes_it() {
        use axum::{
            Json, Router,
            http::StatusCode,
            response::IntoResponse,
            routing::{get, post},
        };

        use super::{ConnectHostRequest, NEEDS_TOKEN};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let revoked = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let revoked_flag = revoked.clone();
        let router = Router::new()
            .route(
                "/health",
                get(|| async {
                    Json(serde_json::json!({
                        "status": "ok",
                        "host_id": "host-1",
                        "name": "Studio"
                    }))
                }),
            )
            .route(
                "/api/v1/auth/pairings",
                post(|| async {
                    (
                        StatusCode::CREATED,
                        Json(serde_json::json!({
                            "host_id": "host-1",
                            "pairing_id": "0195d6f4-8c37-7b28-a982-6a9e60142f55",
                            "pairing_token": "K7M2NPQX",
                            "expires_at": "2026-08-21T00:00:00Z",
                            "requested_scopes": ["conversation.read"],
                            "preset": "workstation",
                            "reachability": [],
                            "invitation": "vibex-pairing:{}",
                            "connection_code": "K7M2NPQX"
                        })),
                    )
                }),
            )
            .route(
                "/api/v1/auth/pairings/redeem",
                post(|| async {
                    (
                        StatusCode::CREATED,
                        Json(serde_json::json!({
                            "device_id": "0195d6f4-8c37-7b28-a982-6a9e60142f66",
                            "access_token": format!("{}{}", "vbx_device_", "x".repeat(64)),
                            "scopes": ["conversation.read"]
                        })),
                    )
                }),
            )
            .route(
                "/api/v1/capabilities",
                get({
                    let revoked_flag = revoked_flag.clone();
                    move || {
                        let revoked_flag = revoked_flag.clone();
                        async move {
                            if revoked_flag.load(std::sync::atomic::Ordering::SeqCst) {
                                return (
                                    StatusCode::UNAUTHORIZED,
                                    Json(serde_json::json!({ "message": "revoked" })),
                                )
                                    .into_response();
                            }
                            (
                                StatusCode::OK,
                                Json(serde_json::json!({
                                    "server_version": "0.1.3",
                                    "protocol_version": "1.0",
                                    "minimum_client_version": "0.1.0",
                                    "capabilities": ["conversation.read"],
                                    "host_id": "host-1",
                                    "reachability": []
                                })),
                            )
                                .into_response()
                        }
                    }
                }),
            );
        let task = tokio::spawn(async move { axum::serve(listener, router).await });
        let dir = tempfile::tempdir().expect("tempdir");
        let runtime = HostClientRuntime::with_path(dir.path().join("profiles.json"));
        let registry = crate::remote_desktop::RemoteDesktopRegistry::new().expect("registry");
        let origin = format!("http://{address}");
        let first = runtime
            .connect(
                "window",
                &registry,
                ConnectHostRequest {
                    origin: Some(origin.clone()),
                    token: Some("K7M2NPQX".into()),
                    profile_id: None,
                },
                async { false },
            )
            .await
            .expect("first connect");
        assert!(first.profile.has_credential);
        assert!(!first.profile.needs_token);

        let second = runtime
            .connect(
                "window",
                &registry,
                ConnectHostRequest {
                    origin: None,
                    token: None,
                    profile_id: Some(first.profile.id.clone()),
                },
                async { false },
            )
            .await
            .expect("remembered connect");
        assert_eq!(second.profile.id, first.profile.id);

        revoked.store(true, std::sync::atomic::Ordering::SeqCst);
        let err = runtime
            .connect(
                "window",
                &registry,
                ConnectHostRequest {
                    origin: None,
                    token: None,
                    profile_id: Some(first.profile.id.clone()),
                },
                async { false },
            )
            .await
            .expect_err("revoked");
        assert!(
            matches!(err, crate::error::AppError::BadRequest(message) if message == NEEDS_TOKEN)
        );
        task.abort();
    }
}
