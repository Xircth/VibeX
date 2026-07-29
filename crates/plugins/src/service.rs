use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, RwLock},
};

use crate::{
    DependencyState, EnableOperation, EnableOperationKind, EnableResult, ManifestSource, Platform,
    PluginActivation, PluginError, PluginManifest, PluginReadiness, PluginSnapshot, ProviderState,
    ReadinessIssue, SkillSource, SkillState, ToolDependencyResolver, ToolRuntimePort,
    manifest::ManifestV2, ports::UnavailableToolRuntime,
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
        Self {
            resolver: ToolDependencyResolver::new(platform),
            runtime,
            plugins: RwLock::new(BTreeMap::new()),
        }
    }

    pub fn import_manifest(
        &self,
        json: &str,
        source: ManifestSource,
    ) -> Result<PluginManifest, PluginError> {
        let manifest = ManifestV2::parse(json, source)?;
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
            for skill in &record.manifest.skills {
                record.skills.insert(
                    skill.id.as_str().to_owned(),
                    match skill.source {
                        SkillSource::Bundled => SkillState::Ready,
                    },
                );
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

        {
            let mut plugins = self.plugins.write().expect("plugin registry poisoned");
            let record = plugins
                .get_mut(plugin_id)
                .expect("plugin cannot disappear during enable");
            for provider in provider_ids(&record.manifest) {
                let state = match record.dependencies.get(&provider) {
                    Some(DependencyState::Ready { .. }) => ProviderState::Ready,
                    _ => ProviderState::Unavailable,
                };
                record.providers.insert(provider, state);
            }
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
}

fn provider_ids(manifest: &PluginManifest) -> BTreeSet<String> {
    manifest
        .actions
        .iter()
        .map(|action| action.artifact_intent.provider.clone())
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
