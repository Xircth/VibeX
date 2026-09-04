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
    Hook,
    FileOpener,
    PreviewProvider,
    AppSurface,
    Toolbar,
    Status,
    ComposerSlash,
    TimelineCard,
    SettingsSection,
    HostService,
    WorkflowBinding,
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
    pub native_renderer: Option<String>,
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
        file_name: Option<&str>,
        extension: Option<&str>,
        media_type: Option<&str>,
    ) -> Result<Option<ResolvedFileOpener>, PluginError> {
        let extension = extension.map(|value| value.trim_start_matches('.').to_ascii_lowercase());
        let file_name = file_name.map(str::to_ascii_lowercase);
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
                let file_name_suffixes = item
                    .metadata
                    .get("fileNameSuffixes")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
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
                let suffix_match = file_name.as_ref().is_some_and(|candidate| {
                    file_name_suffixes.iter().any(|value| {
                        value
                            .as_str()
                            .is_some_and(|suffix| candidate.ends_with(&suffix.to_ascii_lowercase()))
                    })
                });
                if !extension_match && !suffix_match && !media_type_match {
                    return None;
                }
                let handler = item.metadata.get("handler")?.as_str()?.to_owned();
                let native_renderer = state
                    .items
                    .iter()
                    .find(|candidate| {
                        candidate.plugin_id == item.plugin_id
                            && candidate.kind == ContributionKind::AppSurface
                            && candidate.id == handler
                    })
                    .and_then(|surface| surface.metadata.get("nativeRenderer"))
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                Some(ResolvedFileOpener {
                    plugin_id: item.plugin_id.clone(),
                    contribution_id: item.id.clone(),
                    label: item.label.clone(),
                    handler,
                    target: serde_json::from_value(item.metadata.get("target")?.clone()).ok()?,
                    priority: item
                        .metadata
                        .get("priority")
                        .and_then(Value::as_i64)
                        .and_then(|value| i32::try_from(value).ok())
                        .unwrap_or_default(),
                    generation: item.generation,
                    native_renderer,
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
                        "fileNameSuffixes": opener.file_name_suffixes,
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
                        "nativeRenderer": surface.native_renderer,
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
    templates.extend(plugin.app.commands.iter().map(|command| ContributionTemplate {
        plugin_id: plugin_id.clone(),
        id: command.id.clone(),
        kind: ContributionKind::Command,
        label: command.title.clone(),
        metadata: json!({
            "title": command.title,
            "subtitle": command.subtitle,
            "shortcut": command.shortcut,
            "icon": command.icon,
            "handler": command.handler,
        }),
    }));
    templates.extend(plugin.app.toolbar_items.iter().map(|item| ContributionTemplate {
        plugin_id: plugin_id.clone(),
        id: item.id.clone(),
        kind: ContributionKind::Toolbar,
        label: item.title.clone(),
        metadata: json!({
            "title": item.title,
            "icon": item.icon,
            "handler": item.handler,
        }),
    }));
    templates.extend(plugin.app.status_items.iter().map(|item| ContributionTemplate {
        plugin_id: plugin_id.clone(),
        id: item.id.clone(),
        kind: ContributionKind::Status,
        label: item.text.clone().unwrap_or_else(|| item.id.clone()),
        metadata: json!({
            "text": item.text,
            "icon": item.icon,
            "handler": item.handler,
            "refreshSeconds": item.refresh_seconds,
        }),
    }));
    templates.extend(plugin.app.composer_slash.iter().map(|item| ContributionTemplate {
        plugin_id: plugin_id.clone(),
        id: item.id.clone(),
        kind: ContributionKind::ComposerSlash,
        label: item.title.clone(),
        metadata: json!({
            "command": item.command,
            "title": item.title,
            "description": item.description,
            "prompt": item.prompt,
        }),
    }));
    templates.extend(plugin.app.timeline_cards.iter().map(|card| ContributionTemplate {
        plugin_id: plugin_id.clone(),
        id: card.id.clone(),
        kind: ContributionKind::TimelineCard,
        label: card.label.clone(),
        metadata: json!({
            "surfaceId": card.id,
            "handler": card.handler,
            "allowedMethods": card.allowed_methods,
            "minHeight": card.min_height,
        }),
    }));
    templates.extend(
        plugin
            .app
            .settings_sections
            .iter()
            .map(|section| ContributionTemplate {
                plugin_id: plugin_id.clone(),
                id: section.id.clone(),
                kind: ContributionKind::SettingsSection,
                label: section.title.clone(),
                metadata: json!({
                    "surfaceId": section.id,
                    "handler": section.handler,
                    "allowedMethods": section.allowed_methods,
                    "minHeight": section.min_height,
                }),
            }),
    );
    templates.extend(plugin.app.host_services.iter().map(|service| ContributionTemplate {
        plugin_id: plugin_id.clone(),
        id: service.id.clone(),
        kind: ContributionKind::HostService,
        label: service.id.clone(),
        metadata: json!({
            "handler": service.handler,
            "intervalSeconds": service.interval_seconds,
        }),
    }));
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
