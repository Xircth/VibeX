use std::sync::RwLock;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{FileOpenerTarget, InstalledPlugin, InvocationKind, PluginActivation, PluginError};

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ContributionKind {
    Skill,
    Action,
    Command,
    Runtime,
    Mcp,
    FileOpener,
    PreviewProvider,
    AppSurface,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContributionDescriptor {
    pub plugin_id: String,
    pub id: String,
    pub kind: ContributionKind,
    pub label: String,
    pub generation: u64,
    pub metadata: Value,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContributionCatalog {
    pub generation: u64,
    pub items: Vec<ContributionDescriptor>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedFileOpener {
    pub plugin_id: String,
    pub contribution_id: String,
    pub label: String,
    pub handler: String,
    pub target: FileOpenerTarget,
    pub priority: i32,
    pub generation: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ContributionTemplate {
    plugin_id: String,
    id: String,
    kind: ContributionKind,
    label: String,
    metadata: Value,
}

#[derive(Default)]
struct ContributionState {
    generation: u64,
    items: Vec<ContributionDescriptor>,
}

#[derive(Default)]
pub(crate) struct ContributionRegistry {
    state: RwLock<ContributionState>,
}

impl ContributionRegistry {
    pub(crate) fn publish(
        &self,
        mut items: Vec<ContributionDescriptor>,
    ) -> Result<ContributionCatalog, PluginError> {
        items.sort_by(|left, right| {
            left.plugin_id
                .cmp(&right.plugin_id)
                .then_with(|| left.kind.cmp(&right.kind))
                .then_with(|| left.id.cmp(&right.id))
        });
        let mut state = self
            .state
            .write()
            .map_err(|error| PluginError::registry(error.to_string()))?;
        state.generation = items.iter().map(|item| item.generation).max().unwrap_or(0);
        state.items = items;
        Ok(catalog_from(&state))
    }

    pub(crate) fn resolve_file_opener(
        &self,
        extension: Option<&str>,
        media_type: Option<&str>,
    ) -> Result<Option<ResolvedFileOpener>, PluginError> {
        let extension = extension.map(|value| value.trim_start_matches('.').to_ascii_lowercase());
        let media_type = media_type.map(str::to_ascii_lowercase);
        let state = self
            .state
            .read()
            .map_err(|error| PluginError::registry(error.to_string()))?;
        let mut matches = state
            .items
            .iter()
            .filter(|item| item.kind == ContributionKind::FileOpener)
            .filter_map(|item| {
                let extensions = item.metadata.get("extensions")?.as_array()?;
                let media_types = item.metadata.get("mediaTypes")?.as_array()?;
                let extension_match = extension.as_ref().is_some_and(|candidate| {
                    extensions.iter().any(|value| {
                        value
                            .as_str()
                            .is_some_and(|value| value.eq_ignore_ascii_case(candidate))
                    })
                });
                let media_type_match = media_type.as_ref().is_some_and(|candidate| {
                    media_types.iter().any(|value| {
                        value
                            .as_str()
                            .is_some_and(|value| value.eq_ignore_ascii_case(candidate))
                    })
                });
                if !extension_match && !media_type_match {
                    return None;
                }
                Some(ResolvedFileOpener {
                    plugin_id: item.plugin_id.clone(),
                    contribution_id: item.id.clone(),
                    label: item.label.clone(),
                    handler: item.metadata.get("handler")?.as_str()?.to_owned(),
                    target: serde_json::from_value(item.metadata.get("target")?.clone()).ok()?,
                    priority: item
                        .metadata
                        .get("priority")
                        .and_then(Value::as_i64)
                        .and_then(|value| i32::try_from(value).ok())
                        .unwrap_or_default(),
                    generation: item.generation,
                })
            })
            .collect::<Vec<_>>();
        matches.sort_by(|left, right| {
            right
                .priority
                .cmp(&left.priority)
                .then_with(|| left.plugin_id.cmp(&right.plugin_id))
                .then_with(|| left.contribution_id.cmp(&right.contribution_id))
        });
        Ok(matches.into_iter().next())
    }
}

fn catalog_from(state: &ContributionState) -> ContributionCatalog {
    ContributionCatalog {
        generation: state.generation,
        items: state.items.clone(),
    }
}

fn plugin_templates(plugin: &InstalledPlugin) -> Vec<ContributionTemplate> {
    let plugin_id = plugin.id().to_owned();
    let mut templates = plugin
        .skills
        .iter()
        .map(|skill| ContributionTemplate {
            plugin_id: plugin_id.clone(),
            id: skill.id.clone(),
            kind: ContributionKind::Skill,
            label: skill.id.clone(),
            metadata: json!({ "path": skill.path }),
        })
        .chain(plugin.invocations.iter().map(|invocation| {
            let kind = match invocation.kind {
                InvocationKind::Action => ContributionKind::Action,
                InvocationKind::Command => ContributionKind::Command,
            };
            ContributionTemplate {
                plugin_id: plugin_id.clone(),
                id: invocation.id.clone(),
                kind,
                label: invocation.label.clone(),
                metadata: json!({
                    "prompt": invocation.prompt,
                    "skill": invocation.skill,
                    "requiredSkills": invocation.required_skills,
                    "requiredRuntimes": invocation.required_runtimes,
                    "handler": invocation.handler,
                    "artifactIntent": invocation.artifact_intent,
                }),
            }
        }))
        .chain(plugin.runtimes.iter().map(|runtime| ContributionTemplate {
            plugin_id: plugin_id.clone(),
            id: runtime.id.clone(),
            kind: ContributionKind::Runtime,
            label: runtime.id.clone(),
            metadata: json!({
                "command": runtime.command,
                "version": runtime.version,
                "probe": runtime.probe,
            }),
        }))
        .chain(
            plugin
                .app
                .file_openers
                .iter()
                .map(|opener| ContributionTemplate {
                    plugin_id: plugin_id.clone(),
                    id: opener.id.clone(),
                    kind: ContributionKind::FileOpener,
                    label: opener.label.clone(),
                    metadata: json!({
                        "extensions": opener.extensions,
                        "mediaTypes": opener.media_types,
                        "priority": opener.priority,
                        "handler": opener.handler,
                        "target": opener.target,
                    }),
                }),
        )
        .chain(
            plugin
                .app
                .preview_providers
                .iter()
                .map(|provider| ContributionTemplate {
                    plugin_id: plugin_id.clone(),
                    id: provider.id.clone(),
                    kind: ContributionKind::PreviewProvider,
                    label: provider.id.clone(),
                    metadata: json!({
                        "mediaTypes": provider.media_types,
                        "runtime": provider.runtime,
                        "maxConcurrentPreviews": provider.max_concurrent_previews,
                        "handler": provider.handler,
                        "process": provider.process,
                    }),
                }),
        )
        .chain(
            plugin
                .app
                .surfaces
                .iter()
                .map(|surface| ContributionTemplate {
                    plugin_id: plugin_id.clone(),
                    id: surface.id.clone(),
                    kind: ContributionKind::AppSurface,
                    label: surface.label.clone(),
                    metadata: json!({
                        "slot": surface.slot,
                        "appEntrypoint": surface.app_entrypoint,
                        "route": surface.route,
                        "handler": surface.handler,
                        "allowedMethods": surface.allowed_methods,
                        "minHeight": surface.min_height,
                    }),
                }),
        )
        .collect::<Vec<_>>();
    if let Some(mcp) = plugin.mcp.as_object() {
        templates.extend(mcp.keys().map(|id| ContributionTemplate {
            plugin_id: plugin_id.clone(),
            id: id.clone(),
            kind: ContributionKind::Mcp,
            label: id.clone(),
            metadata: Value::Null,
        }));
    }
    templates
}

pub(crate) fn descriptors_for_package(
    package: &crate::PluginPackage,
    generation: u64,
) -> Vec<ContributionDescriptor> {
    let installed = InstalledPlugin {
        package: package.clone(),
        activation: PluginActivation::Enabled,
        package_digest: String::new(),
    };
    let mut descriptors = plugin_templates(&installed)
        .into_iter()
        .map(|item| ContributionDescriptor {
            plugin_id: item.plugin_id,
            id: item.id,
            kind: item.kind,
            label: item.label,
            generation,
            metadata: item.metadata,
        })
        .collect::<Vec<_>>();
    descriptors.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then_with(|| left.id.cmp(&right.id))
    });
    descriptors
}
