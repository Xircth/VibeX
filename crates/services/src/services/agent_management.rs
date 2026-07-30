use std::collections::{HashMap, HashSet};

use agents::{
    BuiltInProfileCatalog, ProfileInstallSource, RegistryCacheFreshness, RegistryDistributions,
    current_platform,
};
use anyhow::Result;
use api_types::{
    AgentAuthenticationStatus, AgentId, AgentLifecycleState, AgentManagementView,
    AgentOperationKind, AgentRegistryView, AgentRegistryViewRow, AgentSource,
};
use db::models::agent_management::{
    AgentMembershipRepository, NewAgentMembership, RegistrySnapshotRepository,
};
use sqlx::{FromRow, SqlitePool};

use super::agent_registry::AgentRegistrySnapshotStore;

#[derive(Debug, FromRow)]
struct InstallationProjection {
    agent_id: String,
    lifecycle: String,
    active_operation: Option<String>,
    current_lock_id: Option<String>,
    rollback_lock_id: Option<String>,
}

#[derive(Debug, FromRow)]
struct ProbeProjection {
    agent_id: String,
    lifecycle: String,
    authentication: String,
}

#[derive(Clone)]
pub struct AgentManagementQueryService {
    pool: SqlitePool,
}

impl AgentManagementQueryService {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn list(&self) -> Result<Vec<AgentManagementView>> {
        let memberships = AgentMembershipRepository::new(self.pool.clone())
            .list()
            .await?;
        let installations = sqlx::query_as::<_, InstallationProjection>(
            "SELECT agent_id, lifecycle, active_operation, current_lock_id, rollback_lock_id FROM agent_installation",
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|row| (row.agent_id.clone(), row))
        .collect::<HashMap<_, _>>();
        let probes = sqlx::query_as::<_, ProbeProjection>(
            "SELECT agent_id, lifecycle, authentication FROM agent_probe",
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|row| (row.agent_id.clone(), row))
        .collect::<HashMap<_, _>>();
        let locks = sqlx::query_as::<_, (String, String, String)>(
            r#"SELECT installation.agent_id,
                      json_extract(lock.resolved_json, '$.runtime_version'),
                      json_extract(lock.resolved_json, '$.acp_version')
               FROM agent_installation installation
               JOIN agent_install_lock lock ON lock.id = installation.current_lock_id"#,
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|(id, runtime, acp)| (id, (runtime, acp)))
        .collect::<HashMap<_, _>>();
        let registry =
            AgentRegistrySnapshotStore::new(RegistrySnapshotRepository::new(self.pool.clone()))
                .load()
                .await?;
        let registry_entries = registry
            .map(|snapshot| {
                snapshot
                    .entries
                    .into_iter()
                    .map(|entry| (entry.agent_id.clone(), entry))
                    .collect::<HashMap<_, _>>()
            })
            .unwrap_or_default();
        let profiles = BuiltInProfileCatalog::bundled();

        memberships
            .into_iter()
            .map(|membership| {
                let profile = profiles.profile(&membership.agent_id);
                let registry = registry_entries.get(&membership.agent_id);
                let retained = membership
                    .retained_metadata_json
                    .as_deref()
                    .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok());
                let display_name = profile
                    .map(|profile| profile.display_name.to_string())
                    .or_else(|| registry.map(|entry| entry.name.clone()))
                    .or_else(|| {
                        retained
                            .as_ref()
                            .and_then(|value| value.get("name"))
                            .and_then(serde_json::Value::as_str)
                            .map(ToString::to_string)
                    })
                    .unwrap_or_else(|| membership.agent_id.to_string());
                let description = profile
                    .map(|profile| profile.description.to_string())
                    .or_else(|| registry.map(|entry| entry.description.clone()))
                    .unwrap_or_default();
                let installation = installations.get(membership.agent_id.as_str());
                let probe = probes.get(membership.agent_id.as_str());
                let lifecycle = if membership.retired {
                    AgentLifecycleState::Retired
                } else if let Some(probe) = probe {
                    parse_lifecycle(&probe.lifecycle)
                } else if installation
                    .and_then(|installation| installation.current_lock_id.as_ref())
                    .is_some()
                {
                    installation
                        .map(|installation| parse_lifecycle(&installation.lifecycle))
                        .unwrap_or(AgentLifecycleState::NeedsRepair)
                } else {
                    AgentLifecycleState::Uninstalled
                };
                let authentication = probe
                    .map(|probe| parse_authentication(&probe.authentication))
                    .unwrap_or(AgentAuthenticationStatus::NotLoggedIn);
                let versions = locks.get(membership.agent_id.as_str());
                Ok(AgentManagementView {
                    agent_id: membership.agent_id,
                    display_name,
                    description,
                    icon_light: profile.map(|profile| profile.icon.light.to_string()),
                    icon_dark: profile.map(|profile| profile.icon.dark.to_string()),
                    icon_svg: membership
                        .retained_icon_svg
                        .clone()
                        .or_else(|| registry.and_then(|entry| entry.icon_svg.clone())),
                    source: membership.source,
                    built_in: membership.built_in,
                    retired: membership.retired,
                    enabled: membership.enabled,
                    position: u32::try_from(membership.position).unwrap_or(u32::MAX),
                    lifecycle,
                    authentication,
                    runtime_version: versions.map(|versions| versions.0.clone()),
                    acp_version: versions.map(|versions| versions.1.clone()),
                    active_operation: installation
                        .and_then(|installation| installation.active_operation.as_deref())
                        .and_then(parse_operation),
                    rollback_available: installation
                        .and_then(|installation| installation.rollback_lock_id.as_ref())
                        .is_some(),
                })
            })
            .collect()
    }

    pub async fn registry_view(
        &self,
        freshness: RegistryCacheFreshness,
        refresh_error: Option<String>,
    ) -> Result<AgentRegistryView> {
        let memberships = self.list().await?;
        let added_ids = memberships
            .iter()
            .map(|membership| membership.agent_id.clone())
            .collect::<HashSet<_>>();
        let store =
            AgentRegistrySnapshotStore::new(RegistrySnapshotRepository::new(self.pool.clone()));
        let snapshot = store.load().await?;
        let profiles = BuiltInProfileCatalog::bundled();
        let mut rows = snapshot
            .as_ref()
            .map(|snapshot| {
                snapshot
                    .entries
                    .iter()
                    .map(|entry| AgentRegistryViewRow {
                        agent_id: entry.agent_id.clone(),
                        registry_id: Some(entry.registry_id.clone()),
                        display_name: entry.name.clone(),
                        description: entry.description.clone(),
                        version: entry.version.clone(),
                        icon_light: profiles
                            .profile(&entry.agent_id)
                            .map(|profile| profile.icon.light.to_string()),
                        icon_dark: profiles
                            .profile(&entry.agent_id)
                            .map(|profile| profile.icon.dark.to_string()),
                        icon_svg: entry.icon_svg.clone(),
                        built_in: memberships
                            .iter()
                            .find(|membership| membership.agent_id == entry.agent_id)
                            .is_some_and(|membership| membership.built_in),
                        added: added_ids.contains(&entry.agent_id),
                        installed: memberships
                            .iter()
                            .find(|membership| membership.agent_id == entry.agent_id)
                            .is_some_and(|membership| {
                                membership.lifecycle != AgentLifecycleState::Uninstalled
                            }),
                        platform_supported: registry_supports_current_platform(
                            &entry.distributions,
                        ),
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for profile in profiles.profiles() {
            if rows.iter().any(|row| row.agent_id == profile.agent_id) {
                continue;
            }
            let membership = memberships
                .iter()
                .find(|membership| membership.agent_id == profile.agent_id);
            let version = profile
                .install_sources
                .last()
                .map(|source| match source {
                    ProfileInstallSource::Npx { version, .. }
                    | ProfileInstallSource::Binary { version, .. } => *version,
                })
                .unwrap_or_default()
                .to_string();
            rows.push(AgentRegistryViewRow {
                agent_id: profile.agent_id.clone(),
                registry_id: profile
                    .registry_binding
                    .as_ref()
                    .map(|binding| binding.registry_id.to_string()),
                display_name: profile.display_name.to_string(),
                description: profile.description.to_string(),
                version,
                icon_light: Some(profile.icon.light.to_string()),
                icon_dark: Some(profile.icon.dark.to_string()),
                icon_svg: None,
                built_in: true,
                added: membership.is_some(),
                installed: membership.is_some_and(|membership| {
                    membership.lifecycle != AgentLifecycleState::Uninstalled
                }),
                platform_supported: profile
                    .supported_platforms
                    .contains(&current_platform().as_str()),
            });
        }
        rows.sort_by(|left, right| {
            right.built_in.cmp(&left.built_in).then_with(|| {
                left.display_name
                    .to_lowercase()
                    .cmp(&right.display_name.to_lowercase())
            })
        });
        let (installed, uninstalled): (Vec<_>, Vec<_>) =
            rows.into_iter().partition(|row| row.installed);
        Ok(AgentRegistryView {
            snapshot_id: snapshot.as_ref().map(|snapshot| snapshot.id.to_string()),
            fetched_at: snapshot
                .as_ref()
                .map(|snapshot| snapshot.fetched_at.to_rfc3339()),
            fresh: freshness == RegistryCacheFreshness::Fresh,
            refresh_error,
            installed,
            uninstalled,
        })
    }

    pub async fn add(&self, agent_id: AgentId) -> Result<AgentManagementView> {
        let existing = self.list().await?;
        if let Some(existing) = existing.into_iter().find(|view| view.agent_id == agent_id) {
            return Ok(existing);
        }
        let store =
            AgentRegistrySnapshotStore::new(RegistrySnapshotRepository::new(self.pool.clone()));
        let snapshot = store.load().await?;
        let entry = snapshot
            .as_ref()
            .and_then(|snapshot| {
                snapshot
                    .entries
                    .iter()
                    .find(|entry| entry.agent_id == agent_id)
            })
            .ok_or_else(|| anyhow::anyhow!("Agent is not in the current Registry snapshot"))?;
        let position = sqlx::query_scalar::<_, i64>(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM agent_membership",
        )
        .fetch_one(&self.pool)
        .await?;
        AgentMembershipRepository::new(self.pool.clone())
            .add(NewAgentMembership {
                agent_id: agent_id.clone(),
                source: AgentSource::OfficialRegistry,
                built_in: false,
                retired: false,
                enabled: true,
                position,
                retained_metadata_json: Some(
                    serde_json::json!({
                        "name": entry.name,
                        "description": entry.description,
                        "version": entry.version,
                        "registry_id": entry.registry_id,
                    })
                    .to_string(),
                ),
                retained_icon_svg: entry.icon_svg.clone(),
            })
            .await?;
        self.list()
            .await?
            .into_iter()
            .find(|view| view.agent_id == agent_id)
            .ok_or_else(|| anyhow::anyhow!("added Agent projection is missing"))
    }
}

fn registry_supports_current_platform(distributions: &RegistryDistributions) -> bool {
    distributions.npx.is_some()
        || distributions.uvx.is_some()
        || distributions
            .binary
            .as_ref()
            .is_some_and(|targets| targets.contains_key(&current_platform()))
}

fn parse_lifecycle(value: &str) -> AgentLifecycleState {
    match value {
        "retired" => AgentLifecycleState::Retired,
        "platform_unsupported" => AgentLifecycleState::PlatformUnsupported,
        "queued" => AgentLifecycleState::Queued,
        "installing" => AgentLifecycleState::Installing,
        "updating" => AgentLifecycleState::Updating,
        "repairing" => AgentLifecycleState::Repairing,
        "needs_auth" => AgentLifecycleState::NeedsAuth,
        "needs_config" => AgentLifecycleState::NeedsConfig,
        "ready" => AgentLifecycleState::Ready,
        "uninstalled" => AgentLifecycleState::Uninstalled,
        _ => AgentLifecycleState::NeedsRepair,
    }
}

fn parse_authentication(value: &str) -> AgentAuthenticationStatus {
    match value {
        "account" => AgentAuthenticationStatus::Account,
        "api_key" => AgentAuthenticationStatus::ApiKey,
        "multiple_unknown" => AgentAuthenticationStatus::MultipleUnknown,
        "not_required" => AgentAuthenticationStatus::NotRequired,
        _ => AgentAuthenticationStatus::NotLoggedIn,
    }
}

fn parse_operation(value: &str) -> Option<AgentOperationKind> {
    match value {
        "install" => Some(AgentOperationKind::Install),
        "update" => Some(AgentOperationKind::Update),
        "repair" => Some(AgentOperationKind::Repair),
        "rollback" => Some(AgentOperationKind::Rollback),
        "uninstall" => Some(AgentOperationKind::Uninstall),
        "remove" => Some(AgentOperationKind::Remove),
        "check" => Some(AgentOperationKind::Check),
        _ => None,
    }
}
