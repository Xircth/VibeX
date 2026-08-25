use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};

use agents::{
    BuiltInProfileCatalog, ComponentProbeState, LaunchComponentEvidence, LaunchGate,
    ManagementFacts, ManagementOperationState, RegistryCacheFreshness, RegistryDistributions,
    RequiredComponentProbe, UserAgentDefinition, UserAgentInstallTarget,
    bundled_community_acp_presets, current_platform, installation_is_complete,
    reduce_management_snapshot,
};
use anyhow::Result;
use api_types::{
    AgentAuthenticationStatus, AgentId, AgentLifecycleState, AgentManagementView,
    AgentOperationKind, AgentRegistryView, AgentRegistryViewRow, AgentSettingsFeature, AgentSource,
    CommunityAcpPresetView, UserAgentDefinitionRequest, UserAgentDefinitionView,
    UserAgentDistributionKind, UserAgentDistributionView, UserAgentEnvironmentVariableView,
    UserAgentIntegrityKind,
};
use db::models::agent_management::{
    AgentMembershipRepository, NewAgentMembership, RegistrySnapshotRepository,
    UserAgentDefinitionRecord, UserAgentDefinitionRepository,
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
        let user_definitions = UserAgentDefinitionRepository::new(self.pool.clone())
            .list()
            .await?
            .into_iter()
            .map(|definition| (definition.agent_id.clone(), definition))
            .collect::<HashMap<_, _>>();
        let profiles = BuiltInProfileCatalog::bundled();
        let membership_ids = memberships
            .iter()
            .map(|membership| membership.agent_id.clone())
            .collect::<HashSet<_>>();
        let canonical_by_registry_id = profiles
            .profiles()
            .iter()
            .filter_map(|profile| {
                profile
                    .registry_binding
                    .as_ref()
                    .map(|binding| (binding.registry_id, &profile.agent_id))
            })
            .collect::<HashMap<_, _>>();
        let memberships = memberships
            .into_iter()
            .filter(|membership| {
                if membership.source != AgentSource::OfficialRegistry {
                    return true;
                }
                let retained_registry_id = membership
                    .retained_metadata_json
                    .as_deref()
                    .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
                    .and_then(|value| {
                        value
                            .get("registry_id")
                            .and_then(serde_json::Value::as_str)
                            .map(ToString::to_string)
                    });
                let registry_id = retained_registry_id
                    .as_deref()
                    .unwrap_or(membership.agent_id.as_str());
                canonical_by_registry_id
                    .get(registry_id)
                    .is_none_or(|canonical_id| {
                        *canonical_id == &membership.agent_id
                            || !membership_ids.contains(*canonical_id)
                    })
            })
            .collect::<Vec<_>>();

        let mut views = Vec::with_capacity(memberships.len());
        for membership in memberships {
            let profile = profiles.profile(&membership.agent_id);
            let registry = registry_entries.get(&membership.agent_id);
            let user_definition = user_definitions.get(&membership.agent_id);
            let retained = membership
                .retained_metadata_json
                .as_deref()
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok());
            let display_name = profile
                .map(|profile| profile.display_name.to_string())
                .or_else(|| user_definition.map(|definition| definition.display_name.clone()))
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
                .or_else(|| user_definition.map(|definition| definition.description.clone()))
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
            // filesystem probes on the UI request path. Explicit checks update
            // installation.lifecycle; session launch only requires the bound
            // user-environment program to still exist.
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
            let platform_supported = profile
                .map(|profile| {
                    profile
                        .supported_platforms
                        .contains(&current_platform().as_str())
                })
                .or_else(|| user_definition.map(user_definition_supports_current_platform))
                .unwrap_or(true);
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
                local_runtime: None,
                active_operation: installation
                    .and_then(|installation| installation.active_operation.as_deref())
                    .and_then(parse_operation),
                rollback_available: installation
                    .and_then(|installation| installation.rollback_lock_id.as_ref())
                    .is_some(),
                settings_features: Some(
                    profile
                        .map(|profile| profile.settings_features.to_vec())
                        .unwrap_or_else(|| {
                            user_definition
                                .filter(|definition| {
                                    definition.skills_shared_store
                                        || definition.skills_directory.as_ref().is_some_and(
                                            |directory| Path::new(directory).is_absolute(),
                                        )
                                })
                                .map(|_| vec![AgentSettingsFeature::NativeSkills])
                                .unwrap_or_default()
                        }),
                ),
            });
        }
        Ok(views)
    }

    /// Revalidate leftover non-user-environment component bytes outside
    /// latency-sensitive snapshot reads. Current user-environment installs are
    /// `external` and skipped; a failed check can only demote the installation.
    pub async fn refresh_component_integrity(&self) -> Result<()> {
        let rows = sqlx::query_as::<_, ComponentProjection>(
            r#"SELECT installation.agent_id, component.component_kind,
                      component.absolute_path, component.sha256
               FROM agent_installation installation
               JOIN agent_install_component component
                 ON component.lock_id = installation.current_lock_id
               WHERE installation.current_lock_id IS NOT NULL
                 AND installation.ownership <> 'external'
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
                                installation_is_complete(membership.lifecycle)
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
        let presets = bundled_community_acp_presets()
            .iter()
            .filter_map(|preset| {
                let agent_id = AgentId::parse(preset.agent_id).ok()?;
                let membership = memberships
                    .iter()
                    .find(|membership| membership.agent_id == agent_id);
                Some(CommunityAcpPresetView {
                    preset_id: preset.preset_id.to_string(),
                    agent_id: agent_id.clone(),
                    display_name: preset.display_name.to_string(),
                    description: preset.description.to_string(),
                    authors: preset
                        .authors
                        .iter()
                        .map(|author| (*author).to_string())
                        .collect(),
                    repository: Some(preset.repository.to_string()),
                    version: preset.version.to_string(),
                    distribution_kind: preset.distribution_kind,
                    distribution_json: preset.distribution_json.to_string(),
                    icon_light: Some(preset.icon_light.to_string()),
                    icon_dark: Some(preset.icon_dark.to_string()),
                    built_in: membership.is_some_and(|membership| membership.built_in),
                    added: added_ids.contains(&agent_id),
                })
            })
            .collect();
        Ok(AgentRegistryView {
            current_platform: current_platform(),
            snapshot_id: snapshot.as_ref().map(|snapshot| snapshot.id.to_string()),
            fetched_at: snapshot
                .as_ref()
                .map(|snapshot| snapshot.fetched_at.to_rfc3339()),
            fresh: freshness == RegistryCacheFreshness::Fresh,
            refresh_error,
            installed,
            uninstalled,
            presets,
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

    pub async fn add_user_definition(
        &self,
        request: UserAgentDefinitionRequest,
    ) -> Result<AgentManagementView> {
        let skills_shared_store = request.skills_shared_store;
        let skills_directory = normalize_skills_directory(request.skills_directory.as_deref())?;
        let definition = UserAgentDefinition::parse(
            request.agent_id,
            request.display_name,
            request.description,
            request.version,
            request.distribution_kind,
            &request.distribution_json,
        )
        .map_err(anyhow::Error::msg)?;
        if BuiltInProfileCatalog::bundled()
            .profile(&definition.agent_id)
            .is_some()
        {
            anyhow::bail!(
                "Agent `{}` conflicts with a Built-in Profile",
                definition.agent_id
            );
        }
        if AgentMembershipRepository::new(self.pool.clone())
            .find(&definition.agent_id)
            .await?
            .is_some()
        {
            anyhow::bail!("Agent `{}` has already been added", definition.agent_id);
        }
        let registry =
            AgentRegistrySnapshotStore::new(RegistrySnapshotRepository::new(self.pool.clone()))
                .load()
                .await?;
        if registry.as_ref().is_some_and(|snapshot| {
            snapshot
                .entries
                .iter()
                .any(|entry| entry.agent_id == definition.agent_id)
        }) {
            anyhow::bail!(
                "Agent `{}` already exists in the official ACP Registry",
                definition.agent_id
            );
        }
        let position = sqlx::query_scalar::<_, i64>(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM agent_membership",
        )
        .fetch_one(&self.pool)
        .await?;
        UserAgentDefinitionRepository::new(self.pool.clone())
            .add_with_membership(
                NewAgentMembership {
                    agent_id: definition.agent_id.clone(),
                    source: AgentSource::UserDefinition,
                    built_in: false,
                    retired: false,
                    enabled: true,
                    position,
                    retained_metadata_json: None,
                    retained_icon_svg: None,
                },
                UserAgentDefinitionRecord {
                    agent_id: definition.agent_id.clone(),
                    display_name: definition.display_name,
                    description: definition.description,
                    version: definition.version,
                    distribution_kind: definition.distribution_kind,
                    distributions_json: definition.distributions_json,
                    definition_sha256: definition.definition_sha256,
                    skills_shared_store,
                    skills_directory,
                    created_at: None,
                    updated_at: None,
                },
            )
            .await?;
        self.list()
            .await?
            .into_iter()
            .find(|view| view.agent_id == definition.agent_id)
            .ok_or_else(|| anyhow::anyhow!("added user Agent projection is missing"))
    }

    pub async fn user_install_target(
        &self,
        agent_id: &AgentId,
    ) -> Result<Option<UserAgentInstallTarget>> {
        let Some(record) = UserAgentDefinitionRepository::new(self.pool.clone())
            .find(agent_id)
            .await?
        else {
            return Ok(None);
        };
        let definition = UserAgentDefinition::parse(
            record.agent_id,
            record.display_name,
            record.description,
            record.version,
            record.distribution_kind,
            &record.distributions_json,
        )
        .map_err(anyhow::Error::msg)?;
        if definition.definition_sha256 != record.definition_sha256 {
            anyhow::bail!("persisted user Agent definition failed its SHA-256 integrity check");
        }
        Ok(Some(definition.install_target()))
    }

    pub async fn user_definition_view(
        &self,
        agent_id: &AgentId,
    ) -> Result<Option<UserAgentDefinitionView>> {
        let Some(record) = UserAgentDefinitionRepository::new(self.pool.clone())
            .find(agent_id)
            .await?
        else {
            return Ok(None);
        };
        let definition = parse_persisted_user_definition(&record)?;
        let installed_definition_sha256 = sqlx::query_as::<_, (Option<String>,)>(
            r#"SELECT json_extract(lock.resolved_json, '$.source.definition_sha256')
               FROM agent_installation installation
               JOIN agent_install_lock lock ON lock.id = installation.current_lock_id
               WHERE installation.agent_id = ?"#,
        )
        .bind(agent_id.as_str())
        .fetch_optional(&self.pool)
        .await?
        .and_then(|row| row.0);
        let reinstall_required = installed_definition_sha256
            .as_ref()
            .is_some_and(|installed| installed != &definition.definition_sha256);
        Ok(Some(UserAgentDefinitionView {
            agent_id: definition.agent_id,
            display_name: definition.display_name,
            description: definition.description,
            version: definition.version,
            distribution_json: definition.distributions_json,
            distribution: user_distribution_view(
                definition.distribution_kind,
                &definition.distributions,
            )?,
            definition_sha256: definition.definition_sha256,
            installed_definition_sha256,
            reinstall_required,
            skills_shared_store: record.skills_shared_store,
            skills_directory: record.skills_directory,
            created_at: record.created_at,
            updated_at: record.updated_at,
        }))
    }

    pub async fn update_user_definition(
        &self,
        request: UserAgentDefinitionRequest,
    ) -> Result<UserAgentDefinitionView> {
        let repository = UserAgentDefinitionRepository::new(self.pool.clone());
        if repository.find(&request.agent_id).await?.is_none() {
            anyhow::bail!("user Agent `{}` does not exist", request.agent_id);
        }
        let active_operation = sqlx::query_scalar::<_, Option<String>>(
            "SELECT active_operation FROM agent_installation WHERE agent_id = ?",
        )
        .bind(request.agent_id.as_str())
        .fetch_optional(&self.pool)
        .await?
        .flatten();
        if active_operation.is_some() {
            anyhow::bail!(
                "Agent `{}` cannot be edited while a management operation is active",
                request.agent_id
            );
        }
        let skills_shared_store = request.skills_shared_store;
        let skills_directory = normalize_skills_directory(request.skills_directory.as_deref())?;
        let definition = UserAgentDefinition::parse(
            request.agent_id,
            request.display_name,
            request.description,
            request.version,
            request.distribution_kind,
            &request.distribution_json,
        )
        .map_err(anyhow::Error::msg)?;
        repository
            .update(UserAgentDefinitionRecord {
                agent_id: definition.agent_id.clone(),
                display_name: definition.display_name,
                description: definition.description,
                version: definition.version,
                distribution_kind: definition.distribution_kind,
                distributions_json: definition.distributions_json,
                definition_sha256: definition.definition_sha256,
                skills_shared_store,
                skills_directory,
                created_at: None,
                updated_at: None,
            })
            .await?;
        self.user_definition_view(&definition.agent_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("updated user Agent projection is missing"))
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
        // Capability catalogs include this generation in their fingerprint.
        // Re-observing identical facts must not invalidate a verified catalog.
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
                 observation_generation = agent_probe.observation_generation +
                   CASE WHEN agent_probe.authentication IS NOT excluded.authentication
                          OR agent_probe.authentication_required IS NOT excluded.authentication_required
                        THEN 1 ELSE 0 END"#,
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
        // Keep the fingerprint stable across periodic probes that report the
        // same facts; only an actual capability/auth boundary change advances it.
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
                 observation_generation = agent_probe.observation_generation +
                   CASE WHEN agent_probe.authentication IS NOT excluded.authentication
                          OR agent_probe.runtime_available IS NOT excluded.runtime_available
                          OR agent_probe.acp_handshake IS NOT excluded.acp_handshake
                          OR agent_probe.authentication_required IS NOT excluded.authentication_required
                        THEN 1 ELSE 0 END"#,
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

fn normalize_skills_directory(raw: Option<&str>) -> Result<Option<String>> {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let path = if raw == "~" {
        dirs::home_dir().ok_or_else(|| anyhow::anyhow!("home directory is unavailable"))?
    } else if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        dirs::home_dir()
            .ok_or_else(|| anyhow::anyhow!("home directory is unavailable"))?
            .join(rest)
    } else {
        PathBuf::from(raw)
    };
    if !path.is_absolute() {
        anyhow::bail!("skills directory must be an absolute path (got {raw:?})");
    }
    Ok(Some(path.to_string_lossy().into_owned()))
}

fn parse_persisted_user_definition(
    record: &UserAgentDefinitionRecord,
) -> Result<UserAgentDefinition> {
    let definition = UserAgentDefinition::parse(
        record.agent_id.clone(),
        record.display_name.clone(),
        record.description.clone(),
        record.version.clone(),
        record.distribution_kind,
        &record.distributions_json,
    )
    .map_err(anyhow::Error::msg)?;
    if definition.definition_sha256 != record.definition_sha256 {
        anyhow::bail!("persisted user Agent definition failed its SHA-256 integrity check");
    }
    Ok(definition)
}

fn user_distribution_view(
    kind: UserAgentDistributionKind,
    distributions: &RegistryDistributions,
) -> Result<UserAgentDistributionView> {
    let platform = current_platform();
    let package_view = |command: &str,
                        distribution: &agents::RegistryPackageDistribution|
     -> UserAgentDistributionView {
        UserAgentDistributionView {
            kind,
            platform: platform.clone(),
            platform_supported: true,
            package: Some(distribution.package.clone()),
            archive_url: None,
            command: command.to_string(),
            args: distribution.args.clone(),
            environment: distribution
                .env
                .iter()
                .map(|(name, value)| UserAgentEnvironmentVariableView {
                    name: name.clone(),
                    value: value.clone(),
                })
                .collect(),
            sha256: None,
            integrity: UserAgentIntegrityKind::EcosystemLock,
        }
    };
    match kind {
        UserAgentDistributionKind::Npx => distributions
            .npx
            .as_ref()
            .map(|distribution| package_view("npx", distribution))
            .ok_or_else(|| anyhow::anyhow!("selected npx distribution is missing")),
        UserAgentDistributionKind::Uvx => distributions
            .uvx
            .as_ref()
            .map(|distribution| package_view("uvx", distribution))
            .ok_or_else(|| anyhow::anyhow!("selected uvx distribution is missing")),
        UserAgentDistributionKind::Binary => {
            let targets = distributions
                .binary
                .as_ref()
                .ok_or_else(|| anyhow::anyhow!("selected binary distribution is missing"))?;
            let platform_supported = targets.contains_key(&platform);
            let (selected_platform, target) = targets
                .get_key_value(&platform)
                .or_else(|| targets.iter().next())
                .ok_or_else(|| anyhow::anyhow!("binary distribution has no platform target"))?;
            Ok(UserAgentDistributionView {
                kind,
                platform: selected_platform.clone(),
                platform_supported,
                package: None,
                archive_url: Some(target.archive.clone()),
                command: target.cmd.clone(),
                args: target.args.clone(),
                environment: target
                    .env
                    .iter()
                    .map(|(name, value)| UserAgentEnvironmentVariableView {
                        name: name.clone(),
                        value: value.clone(),
                    })
                    .collect(),
                sha256: target.sha256.clone(),
                integrity: if target.sha256.is_some() {
                    UserAgentIntegrityKind::Sha256
                } else {
                    UserAgentIntegrityKind::TrustOnFirstUse
                },
            })
        }
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

fn user_definition_supports_current_platform(definition: &UserAgentDefinitionRecord) -> bool {
    let Ok(distributions) =
        agents::parse_registry_distributions_json(&definition.distributions_json)
    else {
        return false;
    };
    match definition.distribution_kind {
        api_types::UserAgentDistributionKind::Binary => distributions
            .binary
            .is_some_and(|targets| targets.contains_key(&current_platform())),
        api_types::UserAgentDistributionKind::Npx => distributions.npx.is_some(),
        api_types::UserAgentDistributionKind::Uvx => distributions.uvx.is_some(),
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

#[cfg(test)]
mod tests {
    use api_types::{AgentAuthenticationStatus, AgentId};
    use sqlx::SqlitePool;

    use super::AgentManagementApplicationService;

    async fn management_pool_with_ready_opencode() -> SqlitePool {
        let pool = SqlitePool::connect(":memory:").await.unwrap();
        sqlx::query(
            r#"CREATE TABLE agent_installation (
                 agent_id TEXT PRIMARY KEY,
                 lifecycle TEXT NOT NULL,
                 current_lock_id TEXT
               )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"CREATE TABLE agent_probe (
                 agent_id TEXT PRIMARY KEY,
                 lifecycle TEXT NOT NULL,
                 authentication TEXT NOT NULL,
                 detail_json TEXT NOT NULL,
                 probed_at TEXT NOT NULL,
                 runtime_available INTEGER NOT NULL DEFAULT 0,
                 acp_handshake INTEGER NOT NULL DEFAULT 0,
                 authentication_required INTEGER NOT NULL DEFAULT 0,
                 observation_generation INTEGER NOT NULL DEFAULT 0
               )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO agent_installation VALUES ('opencode', 'ready', 'lock-1')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            r#"INSERT INTO agent_probe
               VALUES ('opencode', 'ready', 'not_required', '{}',
                       '2026-08-01T00:00:00Z', 1, 1, 0, 49)"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    #[tokio::test]
    async fn authentication_generation_advances_only_when_evidence_changes() {
        let pool = management_pool_with_ready_opencode().await;

        AgentManagementApplicationService::new(pool.clone())
            .sync_authentication(
                &AgentId::parse("opencode").unwrap(),
                AgentAuthenticationStatus::NotRequired,
                Some(false),
            )
            .await
            .unwrap();

        let observation = sqlx::query_as::<_, (String, String, bool, i64)>(
            r#"SELECT lifecycle, authentication, authentication_required,
                      observation_generation
               FROM agent_probe WHERE agent_id = 'opencode'"#,
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            observation,
            ("ready".into(), "not_required".into(), false, 49)
        );

        AgentManagementApplicationService::new(pool.clone())
            .sync_authentication(
                &AgentId::parse("opencode").unwrap(),
                AgentAuthenticationStatus::NotLoggedIn,
                Some(true),
            )
            .await
            .unwrap();
        let changed_generation = sqlx::query_scalar::<_, i64>(
            "SELECT observation_generation FROM agent_probe WHERE agent_id = 'opencode'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(changed_generation, 50);
    }

    #[tokio::test]
    async fn full_probe_generation_advances_only_when_fingerprint_facts_change() {
        let pool = management_pool_with_ready_opencode().await;

        AgentManagementApplicationService::new(pool.clone())
            .record_probe(
                &AgentId::parse("opencode").unwrap(),
                api_types::AgentLifecycleState::Ready,
                AgentAuthenticationStatus::NotRequired,
                true,
                true,
                false,
            )
            .await
            .unwrap();

        let generation = sqlx::query_scalar::<_, i64>(
            "SELECT observation_generation FROM agent_probe WHERE agent_id = 'opencode'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(generation, 49);

        AgentManagementApplicationService::new(pool.clone())
            .record_probe(
                &AgentId::parse("opencode").unwrap(),
                api_types::AgentLifecycleState::NeedsRepair,
                AgentAuthenticationStatus::NotRequired,
                false,
                false,
                false,
            )
            .await
            .unwrap();
        let changed_generation = sqlx::query_scalar::<_, i64>(
            "SELECT observation_generation FROM agent_probe WHERE agent_id = 'opencode'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(changed_generation, 50);
    }
}
