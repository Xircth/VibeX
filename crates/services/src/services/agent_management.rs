use std::collections::{HashMap, HashSet};

use agents::{
    BuiltInProfileCatalog, ComponentProbeState, LaunchComponentEvidence, LaunchGate,
    ManagementFacts, ManagementOperationState, RegistryCacheFreshness, RegistryDistributions,
    RequiredComponentProbe, current_platform, reduce_management_snapshot,
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
    authentication: String,
    authentication_required: bool,
}

#[derive(Debug, FromRow)]
struct ComponentProjection {
    agent_id: String,
    component_kind: String,
    absolute_path: String,
    sha256: Option<String>,
}

#[derive(Clone)]
pub struct AgentManagementApplicationService {
    pool: SqlitePool,
}

impl AgentManagementApplicationService {
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
            "SELECT agent_id, authentication, authentication_required FROM agent_probe",
        )
        .fetch_all(&self.pool)
        .await?
        .into_iter()
        .map(|row| (row.agent_id.clone(), row))
        .collect::<HashMap<_, _>>();
        let mut components = HashMap::<String, Vec<ComponentProjection>>::new();
        for component in sqlx::query_as::<_, ComponentProjection>(
            r#"SELECT installation.agent_id, component.component_kind,
                      component.absolute_path, component.sha256
               FROM agent_installation installation
               JOIN agent_install_component component
                 ON component.lock_id = installation.current_lock_id"#,
        )
        .fetch_all(&self.pool)
        .await?
        {
            components
                .entry(component.agent_id.clone())
                .or_default()
                .push(component);
        }
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

        let mut views = Vec::with_capacity(memberships.len());
        for membership in memberships {
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
            let authentication = probe
                .map(|probe| parse_authentication(&probe.authentication))
                .unwrap_or(AgentAuthenticationStatus::NotLoggedIn);
            let component_rows = components
                .remove(membership.agent_id.as_str())
                .unwrap_or_default();
            // The management list is a persisted read model and must not run
            // filesystem integrity checks on the UI request path. Explicit
            // probes update installation.lifecycle; session launch always
            // performs the authoritative SHA-256 gate again.
            let components_verified = !component_rows.is_empty()
                && installation.is_some_and(|row| row.lifecycle != "needs_repair");
            let required_components = component_rows
                .iter()
                .map(|component| RequiredComponentProbe {
                    component_id: component.component_kind.clone(),
                    state: if components_verified {
                        ComponentProbeState::Verified
                    } else {
                        ComponentProbeState::Damaged
                    },
                })
                .collect::<Vec<_>>();
            let operation = installation
                .and_then(|installation| parse_management_operation(&installation.lifecycle));
            let authentication_required = probe.is_some_and(|probe| probe.authentication_required);
            let platform_supported = profile.is_none_or(|profile| {
                profile
                    .supported_platforms
                    .contains(&current_platform().as_str())
            });
            let snapshot = reduce_management_snapshot(ManagementFacts {
                agent_id: membership.agent_id.clone(),
                enabled: membership.enabled,
                retired: membership.retired,
                platform_supported,
                operation,
                installation_present: installation
                    .and_then(|installation| installation.current_lock_id.as_ref())
                    .is_some(),
                required_components,
                authentication,
                authentication_required,
                configuration_required: false,
                configuration_present: true,
            });
            let versions = locks.get(membership.agent_id.as_str());
            views.push(AgentManagementView {
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
                lifecycle: snapshot.lifecycle,
                authentication: snapshot.authentication,
                runtime_version: versions.map(|versions| versions.0.clone()),
                acp_version: versions.map(|versions| versions.1.clone()),
                active_operation: installation
                    .and_then(|installation| installation.active_operation.as_deref())
                    .and_then(parse_operation),
                rollback_available: installation
                    .and_then(|installation| installation.rollback_lock_id.as_ref())
                    .is_some(),
            });
        }
        Ok(views)
    }

    /// Revalidate installed component bytes outside latency-sensitive snapshot
    /// reads. A failed check can only demote the installation; successful
    /// recovery still requires the normal repair/preflight flow.
    pub async fn refresh_component_integrity(&self) -> Result<()> {
        let rows = sqlx::query_as::<_, ComponentProjection>(
            r#"SELECT installation.agent_id, component.component_kind,
                      component.absolute_path, component.sha256
               FROM agent_installation installation
               JOIN agent_install_component component
                 ON component.lock_id = installation.current_lock_id
               WHERE installation.current_lock_id IS NOT NULL
                 AND installation.active_operation IS NULL"#,
        )
        .fetch_all(&self.pool)
        .await?;
        let mut by_agent = HashMap::<String, Vec<ComponentProjection>>::new();
        for row in rows {
            by_agent.entry(row.agent_id.clone()).or_default().push(row);
        }

        for (agent_id, components) in by_agent {
            let evidence = components
                .into_iter()
                .map(|component| LaunchComponentEvidence {
                    component_kind: component.component_kind,
                    absolute_path: component.absolute_path.into(),
                    expected_sha256: component.sha256.unwrap_or_default(),
                })
                .collect::<Vec<_>>();
            if evidence.is_empty() || LaunchGate::verify_components(&evidence).await.is_err() {
                sqlx::query(
                    r#"UPDATE agent_installation
                       SET lifecycle = 'needs_repair', updated_at = CURRENT_TIMESTAMP
                       WHERE agent_id = ? AND current_lock_id IS NOT NULL
                         AND active_operation IS NULL"#,
                )
                .bind(agent_id)
                .execute(&self.pool)
                .await?;
            }
        }
        Ok(())
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
                        authors: entry.authors.clone(),
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
                                membership.lifecycle == AgentLifecycleState::Ready
                            }),
                        platform_supported: registry_supports_current_platform(
                            &entry.distributions,
                        ),
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
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
        if snapshot.as_ref().is_none_or(|snapshot| {
            chrono::Utc::now().signed_duration_since(snapshot.fetched_at)
                > chrono::Duration::hours(24)
        }) {
            anyhow::bail!("ACP Registry snapshot is stale; refresh before adding an Agent");
        }
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

    /// Reconcile authentication and lifecycle as one typed application-core
    /// operation. Callers can either retain the latest requirement fact or
    /// provide fresh evidence from an ACP/native-config probe.
    pub async fn sync_authentication(
        &self,
        agent_id: &AgentId,
        authentication: AgentAuthenticationStatus,
        authentication_required: Option<bool>,
    ) -> Result<()> {
        let authentication_required = match authentication_required {
            Some(value) => value,
            None => sqlx::query_scalar::<_, bool>(
                "SELECT authentication_required FROM agent_probe WHERE agent_id = ?",
            )
            .bind(agent_id.as_str())
            .fetch_optional(&self.pool)
            .await?
            .unwrap_or(false),
        };
        let installation = sqlx::query_as::<_, (String, Option<String>)>(
            "SELECT lifecycle, current_lock_id FROM agent_installation WHERE agent_id = ?",
        )
        .bind(agent_id.as_str())
        .fetch_optional(&self.pool)
        .await?;
        let Some((current_lifecycle, current_lock_id)) = installation else {
            return Ok(());
        };
        let lifecycle = if current_lock_id.is_none() {
            "uninstalled"
        } else if authentication_required
            && matches!(
                authentication,
                AgentAuthenticationStatus::NotLoggedIn | AgentAuthenticationStatus::MultipleUnknown
            )
        {
            "needs_auth"
        } else if matches!(
            current_lifecycle.as_str(),
            "ready" | "needs_auth" | "needs_config"
        ) {
            "ready"
        } else {
            current_lifecycle.as_str()
        };
        sqlx::query(
            r#"INSERT INTO agent_probe
               (agent_id, lifecycle, authentication, detail_json, probed_at,
                runtime_available, acp_handshake, authentication_required,
                observation_generation)
               VALUES (?, ?, ?, '{}', CURRENT_TIMESTAMP, 0, 0, ?, 1)
               ON CONFLICT(agent_id) DO UPDATE SET
                 lifecycle = excluded.lifecycle,
                 authentication = excluded.authentication,
                 authentication_required = excluded.authentication_required,
                 probed_at = excluded.probed_at,
                 observation_generation = agent_probe.observation_generation + 1"#,
        )
        .bind(agent_id.as_str())
        .bind(lifecycle)
        .bind(authentication_key(authentication))
        .bind(authentication_required)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn record_probe(
        &self,
        agent_id: &AgentId,
        lifecycle: AgentLifecycleState,
        authentication: AgentAuthenticationStatus,
        runtime_available: bool,
        acp_handshake: bool,
        authentication_required: bool,
    ) -> Result<()> {
        sqlx::query(
            r#"INSERT INTO agent_probe
               (agent_id, lifecycle, authentication, detail_json, probed_at,
                runtime_available, acp_handshake, authentication_required,
                observation_generation)
               VALUES (?, ?, ?, '{}', CURRENT_TIMESTAMP, ?, ?, ?, 1)
               ON CONFLICT(agent_id) DO UPDATE SET
                 lifecycle = excluded.lifecycle,
                 authentication = excluded.authentication,
                 runtime_available = excluded.runtime_available,
                 acp_handshake = excluded.acp_handshake,
                 authentication_required = excluded.authentication_required,
                 probed_at = excluded.probed_at,
                 observation_generation = agent_probe.observation_generation + 1"#,
        )
        .bind(agent_id.as_str())
        .bind(lifecycle_key(lifecycle))
        .bind(authentication_key(authentication))
        .bind(runtime_available)
        .bind(acp_handshake)
        .bind(authentication_required)
        .execute(&self.pool)
        .await?;
        Ok(())
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

fn parse_authentication(value: &str) -> AgentAuthenticationStatus {
    match value {
        "account" => AgentAuthenticationStatus::Account,
        "api_key" => AgentAuthenticationStatus::ApiKey,
        "multiple_unknown" => AgentAuthenticationStatus::MultipleUnknown,
        "not_required" => AgentAuthenticationStatus::NotRequired,
        _ => AgentAuthenticationStatus::NotLoggedIn,
    }
}

fn authentication_key(authentication: AgentAuthenticationStatus) -> &'static str {
    match authentication {
        AgentAuthenticationStatus::Account => "account",
        AgentAuthenticationStatus::ApiKey => "api_key",
        AgentAuthenticationStatus::NotLoggedIn => "not_logged_in",
        AgentAuthenticationStatus::MultipleUnknown => "multiple_unknown",
        AgentAuthenticationStatus::NotRequired => "not_required",
    }
}

fn lifecycle_key(lifecycle: AgentLifecycleState) -> &'static str {
    match lifecycle {
        AgentLifecycleState::Retired => "retired",
        AgentLifecycleState::PlatformUnsupported => "platform_unsupported",
        AgentLifecycleState::Queued => "queued",
        AgentLifecycleState::Installing => "installing",
        AgentLifecycleState::Updating => "updating",
        AgentLifecycleState::Repairing => "repairing",
        AgentLifecycleState::NeedsRepair => "needs_repair",
        AgentLifecycleState::NeedsAuth => "needs_auth",
        AgentLifecycleState::NeedsConfig => "needs_config",
        AgentLifecycleState::Ready => "ready",
        AgentLifecycleState::Uninstalled => "uninstalled",
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

fn parse_management_operation(value: &str) -> Option<ManagementOperationState> {
    match value {
        "queued" => Some(ManagementOperationState::Queued),
        "installing" => Some(ManagementOperationState::Installing),
        "updating" => Some(ManagementOperationState::Updating),
        "repairing" => Some(ManagementOperationState::Repairing),
        _ => None,
    }
}
