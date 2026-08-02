use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, RwLock},
};

use crate::{
    DependencyState, EnableOperation, EnableOperationKind, EnableResult, ManifestSource, Platform,
    PluginActivation, PluginError, PluginManifest, PluginReadiness, PluginSnapshot, ProviderState,
    ReadinessIssue, SkillAvailabilityPort, SkillState, ToolDependencyResolver, ToolRuntimePort,
    manifest::ManifestV2,
    ports::{UnavailableSkillAvailability, UnavailableToolRuntime},
};

struct PluginRecord {
    manifest: PluginManifest,
    activation: PluginActivation,
    dependencies: BTreeMap<String, DependencyState>,
    skills: BTreeMap<String, SkillState>,
    providers: BTreeMap<String, ProviderState>,
}

pub struct PluginService {
    resolver: ToolDependencyResolver,
    runtime: Arc<dyn ToolRuntimePort>,
    skill_availability: Arc<dyn SkillAvailabilityPort>,
    known_providers: BTreeSet<String>,
    plugins: RwLock<BTreeMap<String, PluginRecord>>,
}

impl Default for PluginService {
    fn default() -> Self {
        Self::new()
    }
}

impl PluginService {
    pub fn new() -> Self {
        Self::with_runtime(Platform::host(), Arc::new(UnavailableToolRuntime))
    }

    pub fn with_runtime(platform: Platform, runtime: Arc<dyn ToolRuntimePort>) -> Self {
        Self::with_runtime_and_capabilities(
            platform,
            runtime,
            Arc::new(UnavailableSkillAvailability),
            ["officecli"],
        )
    }

    pub fn with_runtime_and_capabilities(
        platform: Platform,
        runtime: Arc<dyn ToolRuntimePort>,
        skill_availability: Arc<dyn SkillAvailabilityPort>,
        known_providers: impl IntoIterator<Item = impl Into<String>>,
    ) -> Self {
        Self {
            resolver: ToolDependencyResolver::new(platform),
            runtime,
            skill_availability,
            known_providers: known_providers.into_iter().map(Into::into).collect(),
            plugins: RwLock::new(BTreeMap::new()),
        }
    }

    pub fn import_manifest(
        &self,
        json: &str,
        source: ManifestSource,
    ) -> Result<PluginManifest, PluginError> {
        let manifest = ManifestV2::parse(json, source)?;
        for provider in provider_ids(&manifest) {
            if !self.known_providers.contains(&provider) {
                return Err(PluginError::unknown_provider(
                    manifest.id.as_str(),
                    &provider,
                ));
            }
        }
        let record = PluginRecord {
            dependencies: manifest
                .dependencies
                .iter()
                .map(|dependency| (dependency.id.as_str().to_owned(), DependencyState::Missing))
                .collect(),
            skills: manifest
                .skills
                .iter()
                .map(|skill| (skill.id.as_str().to_owned(), SkillState::Missing))
                .collect(),
            providers: provider_ids(&manifest)
                .into_iter()
                .map(|provider| (provider, ProviderState::Unavailable))
                .collect(),
            activation: PluginActivation::Disabled,
            manifest: manifest.clone(),
        };
        self.plugins
            .write()
            .expect("plugin registry poisoned")
            .insert(manifest.id.as_str().to_owned(), record);
        Ok(manifest)
    }

    pub async fn enable(&self, plugin_id: &str) -> Result<EnableResult, PluginError> {
        let manifest = {
            let mut plugins = self.plugins.write().expect("plugin registry poisoned");
            let record = plugins
                .get_mut(plugin_id)
                .ok_or_else(|| PluginError::not_found(plugin_id))?;
            record.activation = PluginActivation::Enabled;
            for state in record.dependencies.values_mut() {
                *state = DependencyState::Installing;
            }
            record.manifest.clone()
        };
        let operation = EnableOperation {
            kind: if manifest.dependencies.is_empty() {
                EnableOperationKind::Ready
            } else {
                EnableOperationKind::Installing
            },
            dependency_ids: manifest
                .dependencies
                .iter()
                .map(|dependency| dependency.id.as_str().to_owned())
                .collect(),
        };

        for skill in &manifest.skills {
            let state = match self.skill_availability.check_skill(skill).await {
                Ok(()) => SkillState::Ready,
                Err(error) if error.code() == "skill_missing" => SkillState::Missing,
                Err(error) => SkillState::Failed {
                    code: error.code().to_owned(),
                    message: error.message().to_owned(),
                },
            };
            self.plugins
                .write()
                .expect("plugin registry poisoned")
                .get_mut(plugin_id)
                .expect("plugin cannot disappear during enable")
                .skills
                .insert(skill.id.as_str().to_owned(), state);
        }

        for dependency in &manifest.dependencies {
            let state = match self.resolver.resolve(dependency) {
                Ok(resolved) => match self.runtime.ensure(&resolved).await {
                    Ok(tool) => DependencyState::Ready {
                        version: tool.version,
                        executable_path: tool.executable_path,
                    },
                    Err(error) => DependencyState::Failed {
                        code: error.code().to_owned(),
                        message: error.message().to_owned(),
                    },
                },
                Err(error) => DependencyState::Incompatible {
                    code: error.code().to_owned(),
                    message: error.message().to_owned(),
                },
            };
            self.plugins
                .write()
                .expect("plugin registry poisoned")
                .get_mut(plugin_id)
                .expect("plugin cannot disappear during enable")
                .dependencies
                .insert(dependency.id.as_str().to_owned(), state);
        }

        for provider in provider_ids(&manifest) {
            let managed_tool = {
                let plugins = self.plugins.read().expect("plugin registry poisoned");
                match plugins
                    .get(plugin_id)
                    .expect("plugin cannot disappear during enable")
                    .dependencies
                    .get(&provider)
                {
                    Some(DependencyState::Ready {
                        version,
                        executable_path,
                    }) => Some(crate::ManagedTool {
                        version: version.clone(),
                        executable_path: executable_path.clone(),
                    }),
                    _ => None,
                }
            };
            let state = match managed_tool {
                Some(tool) => match self.runtime.check_provider(&provider, &tool).await {
                    Ok(()) => ProviderState::Ready,
                    Err(error) if error.code() == "provider_unavailable" => {
                        ProviderState::Unavailable
                    }
                    Err(error) => ProviderState::Degraded {
                        code: error.code().to_owned(),
                        message: error.message().to_owned(),
                    },
                },
                None => ProviderState::Unavailable,
            };
            self.plugins
                .write()
                .expect("plugin registry poisoned")
                .get_mut(plugin_id)
                .expect("plugin cannot disappear during enable")
                .providers
                .insert(provider, state);
        }

        Ok(EnableResult {
            operation,
            plugin: self.snapshot(plugin_id)?,
        })
    }

    pub fn snapshot(&self, plugin_id: &str) -> Result<PluginSnapshot, PluginError> {
        let plugins = self.plugins.read().expect("plugin registry poisoned");
        let record = plugins
            .get(plugin_id)
            .ok_or_else(|| PluginError::not_found(plugin_id))?;
        Ok(snapshot(record))
    }

    pub fn disable(&self, plugin_id: &str) -> Result<PluginSnapshot, PluginError> {
        let mut plugins = self.plugins.write().expect("plugin registry poisoned");
        let record = plugins
            .get_mut(plugin_id)
            .ok_or_else(|| PluginError::not_found(plugin_id))?;
        record.activation = PluginActivation::Disabled;
        record
            .dependencies
            .values_mut()
            .for_each(|state| *state = DependencyState::Missing);
        record
            .skills
            .values_mut()
            .for_each(|state| *state = SkillState::Missing);
        record
            .providers
            .values_mut()
            .for_each(|state| *state = ProviderState::Unavailable);
        Ok(snapshot(record))
    }
}

fn provider_ids(manifest: &PluginManifest) -> BTreeSet<String> {
    manifest
        .actions
        .iter()
        .filter_map(|action| {
            action
                .artifact_intent
                .as_ref()
                .map(|intent| intent.provider.clone())
        })
        .collect()
}

fn snapshot(record: &PluginRecord) -> PluginSnapshot {
    let mut issues = Vec::new();
    for (id, state) in &record.dependencies {
        match state {
            DependencyState::Ready { .. } => {}
            DependencyState::Failed { code, message }
            | DependencyState::Incompatible { code, message } => issues.push(ReadinessIssue {
                component: "dependency".to_string(),
                id: id.clone(),
                code: code.clone(),
                message: message.clone(),
            }),
            DependencyState::Missing => issues.push(ReadinessIssue {
                component: "dependency".to_string(),
                id: id.clone(),
                code: "tool_missing".to_string(),
                message: format!("tool `{id}` is not installed"),
            }),
            DependencyState::Installing => issues.push(ReadinessIssue {
                component: "dependency".to_string(),
                id: id.clone(),
                code: "tool_installing".to_string(),
                message: format!("tool `{id}` is installing"),
            }),
        }
    }
    for (id, state) in &record.skills {
        if !matches!(state, SkillState::Ready) {
            issues.push(ReadinessIssue {
                component: "skill".to_string(),
                id: id.clone(),
                code: "skill_not_ready".to_string(),
                message: format!("skill `{id}` is not ready"),
            });
        }
    }
    for (id, state) in &record.providers {
        if !matches!(state, ProviderState::Ready) {
            issues.push(ReadinessIssue {
                component: "provider".to_string(),
                id: id.clone(),
                code: "provider_unavailable".to_string(),
                message: format!("provider `{id}` is unavailable"),
            });
        }
    }
    PluginSnapshot {
        id: record.manifest.id.clone(),
        membership: record.manifest.membership,
        activation: record.activation,
        dependencies: record.dependencies.clone(),
        skills: record.skills.clone(),
        providers: record.providers.clone(),
        readiness: if issues.is_empty() {
            PluginReadiness::Ready
        } else {
            PluginReadiness::NotReady { issues }
        },
    }
}
