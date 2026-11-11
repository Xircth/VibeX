use std::collections::HashSet;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    error::AppError,
    host_client::{
        DEFAULT_PORT, HostClientRuntime, StoredProfile, StoredState, is_loopback_http_origin,
        normalize_origin, provision_target_key, remove_saved_ssh_host_file,
        write_saved_ssh_host_file,
    },
    remote_desktop::RemoteDesktopRegistry,
};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncableHostCredential {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    pub access_token: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncableHostProfile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_key: Option<String>,
    pub profile_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_id: Option<String>,
    pub name: String,
    pub origin: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provision_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provision: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub credential: Option<SyncableHostCredential>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_connected_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingCloudDelete {
    pub id: String,
    pub account_user_id: String,
    pub profile_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh_target: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSyncBundle {
    pub profiles: Vec<SyncableHostProfile>,
    pub pending_deletes: Vec<PendingCloudDelete>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeSyncResult {
    pub changed: bool,
    pub closed_windows: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSwitchResult {
    pub changed: bool,
    pub closed_windows: Vec<String>,
}

pub fn normalize_raw_host_id(value: Option<&str>) -> Option<String> {
    let raw = value?.trim();
    if raw.is_empty() {
        return None;
    }
    let stripped = raw.strip_prefix("host:").unwrap_or(raw).trim();
    (!stripped.is_empty()).then(|| stripped.to_string())
}

fn is_loopback_hostname(host: &str) -> bool {
    let clean = host
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    clean.is_empty()
        || clean == "localhost"
        || clean == "::1"
        || clean == "0.0.0.0"
        || clean.starts_with("127.")
}

pub fn sanitize_provision_for_sync(
    provision_kind: Option<&str>,
    raw: Option<&serde_json::Value>,
) -> Option<serde_json::Value> {
    let kind = provision_kind?.trim();
    if kind.is_empty() {
        return None;
    }
    let obj = raw?.as_object()?;
    let mut out = serde_json::Map::new();

    if let Some(user) = obj
        .get("user")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        out.insert("user".into(), serde_json::Value::String(user.to_string()));
    }

    if let Some(host) = obj
        .get("host")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        out.insert("host".into(), serde_json::Value::String(host.to_string()));
    }

    let port = obj
        .get("port")
        .and_then(serde_json::Value::as_u64)
        .filter(|value| (1..=65535).contains(value))
        .or_else(|| (kind == "ssh" && out.contains_key("host")).then_some(22));
    if let Some(port) = port {
        out.insert("port".into(), serde_json::Value::Number(port.into()));
    }

    if let Some(jump) = obj
        .get("jump")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        out.insert("jump".into(), serde_json::Value::String(jump.to_string()));
    }

    if let Some(service_port) = obj
        .get("servicePort")
        .or_else(|| obj.get("service_port"))
        .and_then(serde_json::Value::as_u64)
        .filter(|value| (1..=65535).contains(value))
    {
        out.insert(
            "servicePort".into(),
            serde_json::Value::Number(service_port.into()),
        );
    }

    if let Some(addresses) = obj.get("addresses").and_then(serde_json::Value::as_array) {
        let mut clean_addrs = Vec::new();
        for entry in addresses {
            let Some(text) = entry.as_str() else {
                continue;
            };
            let Ok(normalized) = normalize_origin(text) else {
                continue;
            };
            if !is_loopback_http_origin(&normalized) && !clean_addrs.contains(&normalized) {
                clean_addrs.push(normalized);
                if clean_addrs.len() >= 8 {
                    break;
                }
            }
        }
        if !clean_addrs.is_empty() {
            out.insert(
                "addresses".into(),
                serde_json::Value::Array(
                    clean_addrs
                        .into_iter()
                        .map(serde_json::Value::String)
                        .collect(),
                ),
            );
        }
    }

    if kind == "ssh" {
        let host = out
            .get("host")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let user = out
            .get("user")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        if host.is_empty() || user.is_empty() || is_loopback_hostname(host) {
            return None;
        }
    }

    (!out.is_empty()).then_some(serde_json::Value::Object(out))
}

pub fn resolve_syncable_origin(
    origin: &str,
    provision_kind: Option<&str>,
    sanitized_provision: Option<&serde_json::Value>,
) -> Option<String> {
    let normalized = normalize_origin(origin).ok();
    if provision_kind == Some("ssh") {
        let provision = sanitized_provision?.as_object()?;
        let host = provision.get("host")?.as_str()?.trim();
        let user = provision.get("user")?.as_str()?.trim();
        if host.is_empty() || user.is_empty() || is_loopback_hostname(host) {
            return None;
        }
        if let Some(ref url) = normalized
            && !is_loopback_http_origin(url)
        {
            return Some(url.clone());
        }
        if let Some(first_addr) = provision
            .get("addresses")
            .and_then(serde_json::Value::as_array)
            .and_then(|items| items.first())
            .and_then(serde_json::Value::as_str)
        {
            return Some(first_addr.to_string());
        }
        let service_port = provision
            .get("servicePort")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(u64::from(DEFAULT_PORT));
        let host_for_url = if host.contains(':') && !host.starts_with('[') {
            format!("[{host}]")
        } else {
            host.to_string()
        };
        return Some(format!("http://{host_for_url}:{service_port}"));
    }

    let normalized = normalized?;
    (!is_loopback_http_origin(&normalized)).then_some(normalized)
}

pub fn ssh_target_from_provision(provision: Option<&serde_json::Value>) -> Option<String> {
    let obj = provision?.as_object()?;
    let user = obj.get("user")?.as_str()?.trim();
    let host = obj.get("host")?.as_str()?.trim().to_ascii_lowercase();
    if user.is_empty() || host.is_empty() {
        return None;
    }
    let port = obj
        .get("port")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(22);
    Some(format!("ssh:{user}@{host}:{port}"))
}

pub(crate) fn record_pending_cloud_delete(state: &mut StoredState, removed: &StoredProfile) {
    let Some(account_id) = removed
        .account_user_id
        .clone()
        .or_else(|| state.signed_in_account_id.clone())
        .filter(|value| !value.trim().is_empty())
    else {
        return;
    };
    let sanitized_provision =
        sanitize_provision_for_sync(removed.provision_kind.as_deref(), removed.provision.as_ref());
    let sync_origin = resolve_syncable_origin(
        &removed.origin,
        removed.provision_kind.as_deref(),
        sanitized_provision.as_ref(),
    );
    let host_id = normalize_raw_host_id(removed.host_id.as_deref());
    let ssh_target = if removed.provision_kind.as_deref() == Some("ssh") {
        ssh_target_from_provision(sanitized_provision.as_ref())
    } else {
        None
    };

    if host_id.is_none() && sync_origin.is_none() && ssh_target.is_none() {
        return;
    }

    state.pending_cloud_deletes.push(PendingCloudDelete {
        id: Uuid::new_v4().to_string(),
        account_user_id: account_id,
        profile_id: removed.id.clone(),
        host_id,
        origin: sync_origin,
        ssh_target,
    });
}

fn matches_pending_delete(
    pending: &[PendingCloudDelete],
    account_id: &str,
    incoming: &SyncableHostProfile,
    sanitized_provision: Option<&serde_json::Value>,
    normalized_origin: &str,
) -> bool {
    let incoming_host_id = normalize_raw_host_id(incoming.host_id.as_deref());
    let incoming_ssh = if incoming.provision_kind.as_deref() == Some("ssh") {
        ssh_target_from_provision(sanitized_provision)
    } else {
        None
    };
    pending.iter().any(|item| {
        if item.account_user_id != account_id {
            return false;
        }
        if incoming_host_id.is_some() && item.host_id == incoming_host_id {
            return true;
        }
        if incoming_ssh.is_some() && item.ssh_target == incoming_ssh {
            return true;
        }
        if item.profile_id == incoming.profile_id {
            return true;
        }
        item.origin
            .as_deref()
            .is_some_and(|origin| origin.eq_ignore_ascii_case(normalized_origin))
    })
}

fn same_archive_identity(left: &StoredProfile, right: &StoredProfile) -> bool {
    if left.id == right.id {
        return true;
    }
    if let (Some(a), Some(b)) = (
        normalize_raw_host_id(left.host_id.as_deref()),
        normalize_raw_host_id(right.host_id.as_deref()),
    ) {
        return a == b;
    }
    if let (Some(a), Some(b)) = (
        provision_target_key(
            left.provision_kind.as_deref().unwrap_or(""),
            left.provision.as_ref(),
        ),
        provision_target_key(
            right.provision_kind.as_deref().unwrap_or(""),
            right.provision.as_ref(),
        ),
    ) {
        return a == b;
    }
    !is_loopback_http_origin(&left.origin)
        && !is_loopback_http_origin(&right.origin)
        && left.origin.eq_ignore_ascii_case(&right.origin)
}

impl HostClientRuntime {
    pub async fn set_sync_account(
        &self,
        registry: &RemoteDesktopRegistry,
        account_user_id: Option<&str>,
    ) -> Result<AccountSwitchResult, AppError> {
        let next_id = account_user_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let mut state = self.load_state().await?;
        let mut changed = false;
        let mut profiles_to_disconnect = Vec::new();

        // Stash profiles belonging to a different account out of active state.profiles
        let mut remaining = Vec::with_capacity(state.profiles.len());
        for mut profile in state.profiles.drain(..) {
            let owner = profile
                .account_user_id
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            match (&owner, &next_id) {
                (Some(owner_id), Some(target_id)) if owner_id == target_id => {
                    remaining.push(profile);
                }
                (Some(owner_id), _) => {
                    changed = true;
                    profiles_to_disconnect.push(profile.id.clone());
                    remove_saved_ssh_host_file(self.store_path(), &profile.id);
                    let bucket = state
                        .archived_account_profiles
                        .entry(owner_id.clone())
                        .or_default();
                    if let Some(pos) = bucket
                        .iter()
                        .position(|existing| same_archive_identity(existing, &profile))
                    {
                        bucket[pos] = profile;
                    } else {
                        bucket.push(profile);
                    }
                }
                (None, Some(target_id)) => {
                    profile.account_user_id = Some(target_id.clone());
                    changed = true;
                    remaining.push(profile);
                }
                (None, None) => {
                    remaining.push(profile);
                }
            }
        }
        state.profiles = remaining;

        // Restore any archived profiles belonging to next_id
        if let Some(ref target_id) = next_id
            && let Some(archived) = state.archived_account_profiles.remove(target_id)
        {
            for mut restored in archived {
                restored.account_user_id = Some(target_id.clone());
                if !state
                    .profiles
                    .iter()
                    .any(|existing| same_archive_identity(existing, &restored))
                {
                    write_saved_ssh_host_file(self.store_path(), &restored);
                    state.profiles.push(restored);
                    changed = true;
                }
            }
        }

        if state.signed_in_account_id != next_id {
            state.signed_in_account_id = next_id;
            changed = true;
        }

        let closed_windows = if profiles_to_disconnect.is_empty() {
            Vec::new()
        } else {
            self.disconnect_bound_profiles(registry, &profiles_to_disconnect)
                .await
        };

        if changed {
            self.save_state(&state).await?;
        }

        Ok(AccountSwitchResult {
            changed,
            closed_windows,
        })
    }

    pub async fn export_sync_bundle(
        &self,
        account_user_id: &str,
    ) -> Result<ExportSyncBundle, AppError> {
        let account_id = account_user_id.trim();
        if account_id.is_empty() {
            return Err(AppError::BadRequest("accountUserId is required".to_string()));
        }
        let local_host_id = normalize_raw_host_id(self.local_host_id().await.as_deref());
        let mut state = self.load_state().await?;
        let mut dirty = false;

        if state.signed_in_account_id.as_deref() != Some(account_id) {
            state.signed_in_account_id = Some(account_id.to_string());
            dirty = true;
        }

        let mut exported = Vec::new();
        for profile in &mut state.profiles {
            if let Some(owner) = profile.account_user_id.as_deref()
                && !owner.is_empty()
                && owner != account_id
            {
                continue;
            }
            if profile.account_user_id.is_none() {
                profile.account_user_id = Some(account_id.to_string());
                dirty = true;
            }
            let host_id = normalize_raw_host_id(profile.host_id.as_deref());
            if host_id.is_some() && host_id == local_host_id {
                continue;
            }
            let kind = profile
                .provision_kind
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let sanitized_provision =
                sanitize_provision_for_sync(kind.as_deref(), profile.provision.as_ref());
            if kind.as_deref() == Some("ssh") && sanitized_provision.is_none() {
                continue;
            }
            let Some(sync_origin) = resolve_syncable_origin(
                &profile.origin,
                kind.as_deref(),
                sanitized_provision.as_ref(),
            ) else {
                continue;
            };

            let credential = if !profile.needs_token {
                profile
                    .access_token
                    .as_deref()
                    .map(str::trim)
                    .filter(|token| !token.is_empty())
                    .map(|token| SyncableHostCredential {
                        device_id: profile.device_id.clone(),
                        access_token: token.to_string(),
                    })
            } else {
                None
            };

            let updated_at = profile
                .updated_at
                .clone()
                .or_else(|| profile.last_connected_at.clone())
                .unwrap_or_else(|| Utc::now().to_rfc3339());
            if profile.updated_at.is_none() {
                profile.updated_at = Some(updated_at.clone());
                dirty = true;
            }

            let name = if profile.name.trim().is_empty() {
                sync_origin.clone()
            } else {
                profile.name.clone()
            };

            exported.push(SyncableHostProfile {
                sync_key: None,
                profile_id: profile.id.clone(),
                host_id,
                name,
                origin: sync_origin,
                provision_kind: kind,
                provision: sanitized_provision,
                credential,
                last_connected_at: profile.last_connected_at.clone(),
                updated_at: Some(updated_at),
            });
        }

        let pending_deletes = state
            .pending_cloud_deletes
            .iter()
            .filter(|entry| entry.account_user_id == account_id)
            .cloned()
            .collect();

        if dirty {
            self.save_state(&state).await?;
        }

        Ok(ExportSyncBundle {
            profiles: exported,
            pending_deletes,
        })
    }

    pub async fn ack_sync_deletes(&self, delete_ids: &[String]) -> Result<(), AppError> {
        if delete_ids.is_empty() {
            return Ok(());
        }
        let ack_set: HashSet<&str> = delete_ids.iter().map(String::as_str).collect();
        let mut state = self.load_state().await?;
        let before = state.pending_cloud_deletes.len();
        state
            .pending_cloud_deletes
            .retain(|item| !ack_set.contains(item.id.as_str()));
        if state.pending_cloud_deletes.len() != before {
            self.save_state(&state).await?;
        }
        Ok(())
    }

    pub async fn mark_sync_pushed(
        &self,
        account_user_id: &str,
        profile_ids: &[String],
    ) -> Result<(), AppError> {
        if profile_ids.is_empty() {
            return Ok(());
        }
        let id_set: HashSet<&str> = profile_ids.iter().map(String::as_str).collect();
        let mut state = self.load_state().await?;
        let mut changed = false;
        for profile in &mut state.profiles {
            if id_set.contains(profile.id.as_str())
                && profile.account_user_id.as_deref() == Some(account_user_id)
                && !profile.cloud_synced
            {
                profile.cloud_synced = true;
                changed = true;
            }
        }
        if changed {
            self.save_state(&state).await?;
        }
        Ok(())
    }

    pub async fn merge_sync_profiles(
        &self,
        registry: &RemoteDesktopRegistry,
        account_user_id: &str,
        incoming: Vec<SyncableHostProfile>,
        authoritative: bool,
    ) -> Result<MergeSyncResult, AppError> {
        let account_id = account_user_id.trim();
        if account_id.is_empty() {
            return Err(AppError::BadRequest("accountUserId is required".to_string()));
        }
        let local_host_id = normalize_raw_host_id(self.local_host_id().await.as_deref());
        let active_bound_ids = self.active_bound_profile_ids().await;
        let mut state = self.load_state().await?;
        let mut changed = false;
        let mut matched_local_ids = HashSet::new();

        if state.signed_in_account_id.as_deref() != Some(account_id) {
            state.signed_in_account_id = Some(account_id.to_string());
            changed = true;
        }

        for item in incoming {
            let incoming_host_id = normalize_raw_host_id(item.host_id.as_deref());
            // Never import the current machine itself into its own remote Host list
            if incoming_host_id.is_some() && incoming_host_id == local_host_id {
                continue;
            }

            let kind = item
                .provision_kind
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let sanitized_provision =
                sanitize_provision_for_sync(kind.as_deref(), item.provision.as_ref());
            if kind.as_deref() == Some("ssh") && sanitized_provision.is_none() {
                continue;
            }
            let Some(sync_origin) = resolve_syncable_origin(
                &item.origin,
                kind.as_deref(),
                sanitized_provision.as_ref(),
            ) else {
                continue;
            };

            if matches_pending_delete(
                &state.pending_cloud_deletes,
                account_id,
                &item,
                sanitized_provision.as_ref(),
                &sync_origin,
            ) {
                continue;
            }

            let incoming_target_key =
                provision_target_key(kind.as_deref().unwrap_or(""), sanitized_provision.as_ref());

            let existing_index = state.profiles.iter().position(|existing| {
                if let Some(owner) = existing.account_user_id.as_deref()
                    && !owner.is_empty()
                    && owner != account_id
                {
                    return false;
                }
                if let (Some(saved_hid), Some(inc_hid)) = (
                    normalize_raw_host_id(existing.host_id.as_deref()),
                    incoming_host_id.as_ref(),
                ) && &saved_hid == inc_hid
                {
                    return true;
                }
                if let (Some(saved_key), Some(inc_key)) = (
                    provision_target_key(
                        existing.provision_kind.as_deref().unwrap_or(""),
                        existing.provision.as_ref(),
                    ),
                    incoming_target_key.as_ref(),
                ) && &saved_key == inc_key
                {
                    return true;
                }
                if existing.id == item.profile_id {
                    return true;
                }
                !is_loopback_http_origin(&existing.origin)
                    && existing.origin.eq_ignore_ascii_case(&sync_origin)
            });

            let incoming_credential = item
                .credential
                .and_then(|cred| {
                    let token = cred.access_token.trim().to_string();
                    (!token.is_empty()).then_some(SyncableHostCredential {
                        device_id: cred.device_id.filter(|id| !id.trim().is_empty()),
                        access_token: token,
                    })
                });

            if let Some(idx) = existing_index {
                let profile = &mut state.profiles[idx];
                matched_local_ids.insert(profile.id.clone());

                let keep_live_tunnel_origin = active_bound_ids.contains(&profile.id)
                    && is_loopback_http_origin(&profile.origin);
                if !keep_live_tunnel_origin && profile.origin != sync_origin {
                    profile.origin = sync_origin.clone();
                    changed = true;
                }
                if incoming_host_id.is_some() && profile.host_id != incoming_host_id {
                    profile.host_id = incoming_host_id;
                    changed = true;
                }
                let next_name = item.name.trim();
                if !next_name.is_empty() && profile.name != next_name {
                    profile.name = next_name.to_string();
                    changed = true;
                }
                if kind.is_some() && profile.provision_kind != kind {
                    profile.provision_kind = kind;
                    changed = true;
                }
                if let Some(next_prov) = sanitized_provision
                    && profile.provision.as_ref() != Some(&next_prov)
                {
                    profile.provision = Some(next_prov);
                    changed = true;
                }

                // Credential merge: cloud wins unless local holds a strictly newer valid token
                let local_has_valid_token =
                    !profile.needs_token && profile.access_token.as_ref().is_some_and(|t| !t.is_empty());
                let local_is_newer = match (&profile.updated_at, &item.updated_at) {
                    (Some(local_ts), Some(cloud_ts)) => local_ts > cloud_ts,
                    _ => false,
                };

                if let Some(cred) = incoming_credential {
                    if !local_has_valid_token || !local_is_newer {
                        if profile.access_token.as_deref() != Some(cred.access_token.as_str())
                            || profile.device_id != cred.device_id
                            || profile.needs_token
                        {
                            profile.device_id = cred.device_id;
                            profile.access_token = Some(cred.access_token);
                            profile.needs_token = false;
                            changed = true;
                        }
                    }
                } else if !local_has_valid_token && !profile.needs_token {
                    profile.needs_token = true;
                    changed = true;
                }

                if let Some(ref inc_last) = item.last_connected_at
                    && profile
                        .last_connected_at
                        .as_ref()
                        .is_none_or(|cur| inc_last > cur)
                {
                    profile.last_connected_at = Some(inc_last.clone());
                    changed = true;
                }

                if profile.account_user_id.as_deref() != Some(account_id) {
                    profile.account_user_id = Some(account_id.to_string());
                    changed = true;
                }
                if !local_is_newer && !profile.cloud_synced {
                    profile.cloud_synced = true;
                    changed = true;
                }
                if let Some(inc_updated) = item.updated_at
                    && !local_is_newer
                    && profile.updated_at.as_ref() != Some(&inc_updated)
                {
                    profile.updated_at = Some(inc_updated);
                    changed = true;
                }

                write_saved_ssh_host_file(self.store_path(), profile);
            } else {
                let id = if !item.profile_id.trim().is_empty()
                    && !state.profiles.iter().any(|p| p.id == item.profile_id)
                {
                    item.profile_id.trim().to_string()
                } else {
                    Uuid::new_v4().to_string()
                };
                let (device_id, access_token, needs_token) = match incoming_credential {
                    Some(cred) => (cred.device_id, Some(cred.access_token), false),
                    None => (None, None, true),
                };
                let name = if item.name.trim().is_empty() {
                    sync_origin.clone()
                } else {
                    item.name.trim().to_string()
                };
                let created = StoredProfile {
                    id: id.clone(),
                    origin: sync_origin,
                    host_id: incoming_host_id,
                    name,
                    device_id,
                    access_token,
                    last_connected_at: item.last_connected_at,
                    needs_token,
                    provision_kind: kind,
                    provision: sanitized_provision,
                    account_user_id: Some(account_id.to_string()),
                    cloud_synced: true,
                    updated_at: item.updated_at.or_else(|| Some(Utc::now().to_rfc3339())),
                };
                write_saved_ssh_host_file(self.store_path(), &created);
                matched_local_ids.insert(id);
                state.profiles.push(created);
                changed = true;
            }
        }

        let mut pruned_ids = Vec::new();
        if authoritative {
            state.profiles.retain(|profile| {
                let should_prune = profile.account_user_id.as_deref() == Some(account_id)
                    && profile.cloud_synced
                    && !matched_local_ids.contains(&profile.id);
                if should_prune {
                    remove_saved_ssh_host_file(self.store_path(), &profile.id);
                    pruned_ids.push(profile.id.clone());
                    changed = true;
                    false
                } else {
                    true
                }
            });
        }

        let closed_windows = if pruned_ids.is_empty() {
            Vec::new()
        } else {
            self.disconnect_bound_profiles(registry, &pruned_ids).await
        };

        if changed {
            self.save_state(&state).await?;
        }

        Ok(MergeSyncResult {
            changed,
            closed_windows,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote_desktop::RemoteDesktopRegistry;

    #[tokio::test]
    async fn exports_sanitized_profiles_and_excludes_pure_loopback_and_self_host() {
        let dir = tempfile::tempdir().expect("tempdir");
        let runtime = HostClientRuntime::with_path(dir.path().join("profiles.json"));
        runtime.set_local_host_id(Some("self-host-uuid".to_string())).await;

        let mut state = StoredState {
            signed_in_account_id: Some("user-a".into()),
            profiles: vec![
                // 1) Pure loopback manual profile -> excluded
                StoredProfile {
                    id: "loopback".into(),
                    origin: "http://127.0.0.1:17891".into(),
                    name: "Local".into(),
                    access_token: Some("loop-tok".into()),
                    ..StoredProfile::default()
                },
                // 2) Current machine itself -> excluded
                StoredProfile {
                    id: "self".into(),
                    origin: "http://192.168.1.20:17891".into(),
                    host_id: Some("self-host-uuid".into()),
                    name: "Self".into(),
                    access_token: Some("self-tok".into()),
                    ..StoredProfile::default()
                },
                // 3) SSH profile with loopback tunnel origin + secret fields -> exported & sanitized
                StoredProfile {
                    id: "ssh-1".into(),
                    origin: "http://127.0.0.1:51234".into(),
                    host_id: Some("remote-ssh-id".into()),
                    name: "Dev Server".into(),
                    device_id: Some("dev-ssh".into()),
                    access_token: Some("tok-ssh-secret".into()),
                    needs_token: false,
                    provision_kind: Some("ssh".into()),
                    provision: Some(serde_json::json!({
                        "user": "ubuntu",
                        "host": "10.0.1.50",
                        "port": 22,
                        "password": "DO_NOT_EXPORT_PASSWORD",
                        "dataDir": "/root/.vibex"
                    })),
                    ..StoredProfile::default()
                },
            ],
            ..StoredState::default()
        };
        runtime.save_state(&mut state).await.expect("save");

        let bundle = runtime.export_sync_bundle("user-a").await.expect("export");
        assert_eq!(bundle.profiles.len(), 1);
        let exported = &bundle.profiles[0];
        assert_eq!(exported.profile_id, "ssh-1");
        assert_eq!(exported.origin, "http://10.0.1.50:17891");
        assert_eq!(
            exported.credential.as_ref().map(|c| c.access_token.as_str()),
            Some("tok-ssh-secret")
        );
        let prov_str = serde_json::to_string(&exported.provision).expect("json");
        assert!(!prov_str.contains("DO_NOT_EXPORT_PASSWORD"));
        assert!(!prov_str.contains("dataDir"));
    }

    #[tokio::test]
    async fn isolates_accounts_on_switch_and_reconciles_cloud_merges_and_deletes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let runtime = HostClientRuntime::with_path(dir.path().join("profiles.json"));
        runtime
            .set_local_host_id(Some("device-b-local-id".to_string()))
            .await;
        let registry = RemoteDesktopRegistry::new().expect("registry");

        // Merge cloud profiles for Account A on Device B (including Device B's own hostId, which must be skipped)
        let merged = runtime
            .merge_sync_profiles(
                &registry,
                "user-a",
                vec![
                    SyncableHostProfile {
                        sync_key: Some("host:device-b-local-id".into()),
                        profile_id: "self-on-cloud".into(),
                        host_id: Some("host:device-b-local-id".into()),
                        name: "Device B".into(),
                        origin: "http://192.168.1.99:17891".into(),
                        provision_kind: None,
                        provision: None,
                        credential: Some(SyncableHostCredential {
                            device_id: Some("d0".into()),
                            access_token: "t0".into(),
                        }),
                        last_connected_at: None,
                        updated_at: Some("2026-11-11T10:00:00Z".into()),
                    },
                    SyncableHostProfile {
                        sync_key: Some("host:http-box".into()),
                        profile_id: "prof-http".into(),
                        host_id: Some("http-box".into()),
                        name: "HTTP Box".into(),
                        origin: "http://192.168.1.55:17891".into(),
                        provision_kind: None,
                        provision: None,
                        credential: Some(SyncableHostCredential {
                            device_id: Some("dev-1".into()),
                            access_token: "token-http-1".into(),
                        }),
                        last_connected_at: Some("2026-11-11T10:00:00Z".into()),
                        updated_at: Some("2026-11-11T10:00:00Z".into()),
                    },
                    SyncableHostProfile {
                        sync_key: Some("host:ssh-box".into()),
                        profile_id: "prof-ssh".into(),
                        host_id: Some("ssh-box".into()),
                        name: "SSH Box".into(),
                        origin: "http://10.0.0.77:17891".into(),
                        provision_kind: Some("ssh".into()),
                        provision: Some(serde_json::json!({
                            "user": "root",
                            "host": "10.0.0.77",
                            "port": 22
                        })),
                        credential: Some(SyncableHostCredential {
                            device_id: Some("dev-2".into()),
                            access_token: "token-ssh-2".into(),
                        }),
                        last_connected_at: Some("2026-11-11T10:05:00Z".into()),
                        updated_at: Some("2026-11-11T10:05:00Z".into()),
                    },
                ],
                true,
            )
            .await
            .expect("merge");
        assert!(merged.changed);

        let status_a = runtime.status(&registry, "main").await.expect("status");
        assert_eq!(status_a.profiles.len(), 2);
        assert!(status_a.profiles.iter().all(|p| p.has_credential && !p.needs_token));
        assert!(
            dir.path()
                .join("hosts")
                .join("prof-ssh.sshconfig")
                .is_file()
        );

        // Switch from Account A -> Account B: Account A's profiles must NOT be visible or exported to Account B!
        let switched = runtime
            .set_sync_account(&registry, Some("user-b"))
            .await
            .expect("switch to B");
        assert!(switched.changed);

        let status_b = runtime.status(&registry, "main").await.expect("status B");
        assert!(status_b.profiles.is_empty());
        let export_b = runtime.export_sync_bundle("user-b").await.expect("export B");
        assert!(export_b.profiles.is_empty());

        // Switch back to Account A: profiles are restored, then authoritative cloud list without HTTP Box prunes it!
        runtime
            .set_sync_account(&registry, Some("user-a"))
            .await
            .expect("switch back to A");
        let after_restore = runtime.status(&registry, "main").await.expect("restored A");
        assert_eq!(after_restore.profiles.len(), 2);

        let pruned = runtime
            .merge_sync_profiles(
                &registry,
                "user-a",
                vec![SyncableHostProfile {
                    sync_key: Some("host:ssh-box".into()),
                    profile_id: "prof-ssh".into(),
                    host_id: Some("ssh-box".into()),
                    name: "SSH Box".into(),
                    origin: "http://10.0.0.77:17891".into(),
                    provision_kind: Some("ssh".into()),
                    provision: Some(serde_json::json!({
                        "user": "root",
                        "host": "10.0.0.77",
                        "port": 22
                    })),
                    credential: Some(SyncableHostCredential {
                        device_id: Some("dev-2".into()),
                        access_token: "token-ssh-2".into(),
                    }),
                    last_connected_at: Some("2026-11-11T10:05:00Z".into()),
                    updated_at: Some("2026-11-11T10:05:00Z".into()),
                }],
                true,
            )
            .await
            .expect("prune deleted");
        assert!(pruned.changed);
        let final_a = runtime.status(&registry, "main").await.expect("final A");
        assert_eq!(final_a.profiles.len(), 1);
        assert_eq!(final_a.profiles[0].id, "prof-ssh");
    }
}
