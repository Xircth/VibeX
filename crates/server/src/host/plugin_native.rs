use std::path::Path;

use application::ApplicationError;
use plugins::{NativePluginAdapter, NativePluginDescriptor};
use serde_json::{Value, json};

use crate::domains::{ServerApplicationDomains, internal_error, parse, plugin_error, serialize};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PluginIdentityArgs {
    plugin_id: String,
}

impl ServerApplicationDomains {
    pub(crate) async fn merge_native_cli_plugins(&self, plugins: &mut Vec<Value>) {
        for (adapter, format) in native_cli_adapters().await {
            let Ok(discovered) = adapter.discover().await else {
                continue;
            };
            let capabilities = adapter.capabilities();
            for native in discovered {
                if let Some(existing) = plugins.iter_mut().find(|plugin| {
                    plugin.get("id").and_then(Value::as_str) == Some(native.id.as_str())
                }) {
                    if let Some(formats) = existing.get_mut("formats").and_then(Value::as_array_mut)
                        && !formats.iter().any(|item| item.as_str() == Some(format))
                    {
                        formats.push(Value::String(format.to_owned()));
                    }
                } else {
                    plugins.push(native_plugin_item(native, format, capabilities));
                }
            }
        }
    }

    pub(crate) async fn native_plugin_set_enabled(
        &self,
        plugin_id: &str,
        enabled: bool,
    ) -> Result<Option<Value>, ApplicationError> {
        let Some((adapter, descriptor, format)) = find_native_cli_plugin(plugin_id).await? else {
            return Ok(None);
        };
        adapter
            .set_enabled(&descriptor.id, enabled)
            .await
            .map_err(plugin_error)?;
        let refreshed = find_native_descriptor(&adapter, &descriptor.id).await?;
        Ok(Some(native_plugin_item(
            refreshed,
            format,
            adapter.capabilities(),
        )))
    }

    pub(crate) async fn native_plugin_update(
        &self,
        args: Value,
    ) -> Result<Option<Value>, ApplicationError> {
        let Ok(args) = parse::<PluginIdentityArgs>(args) else {
            return Ok(None);
        };
        let Some((adapter, descriptor, format)) = find_native_cli_plugin(&args.plugin_id).await?
        else {
            return Ok(None);
        };
        adapter.update(&descriptor.id).await.map_err(plugin_error)?;
        let refreshed = find_native_descriptor(&adapter, &descriptor.id).await?;
        Ok(Some(native_plugin_item(
            refreshed,
            format,
            adapter.capabilities(),
        )))
    }

    pub(crate) async fn native_plugin_uninstall(
        &self,
        plugin_id: &str,
    ) -> Result<bool, ApplicationError> {
        let Some((adapter, descriptor, _)) = find_native_cli_plugin(plugin_id).await? else {
            return Ok(false);
        };
        adapter
            .uninstall(&descriptor.id)
            .await
            .map_err(plugin_error)?;
        Ok(true)
    }

    pub(crate) async fn native_plugin_contributions(
        &self,
        plugin_id: &str,
    ) -> Result<Option<Value>, ApplicationError> {
        let Some((_, descriptor, _)) = find_native_cli_plugin(plugin_id).await? else {
            return Ok(None);
        };
        let skills = discover_native_skills(&descriptor.path);
        let mcp = read_native_mcp(&descriptor.path)?;
        serialize(json!({
            "skills": skills,
            "mcp": mcp.unwrap_or(Value::Null),
        }))
        .map(Some)
    }
}

async fn native_cli_adapters() -> Vec<(plugins::OfficialCliNativePluginAdapter, &'static str)> {
    let mut adapters = Vec::new();
    if let Some(program) = utils::shell::resolve_executable_path("codex").await {
        adapters.push((
            plugins::OfficialCliNativePluginAdapter::codex(program),
            "codex",
        ));
    }
    if let Some(program) = utils::shell::resolve_executable_path("claude").await {
        adapters.push((
            plugins::OfficialCliNativePluginAdapter::claude_code(program),
            "claude_code",
        ));
    }
    adapters
}

async fn find_native_cli_plugin(
    plugin_id: &str,
) -> Result<
    Option<(
        plugins::OfficialCliNativePluginAdapter,
        NativePluginDescriptor,
        &'static str,
    )>,
    ApplicationError,
> {
    for (adapter, format) in native_cli_adapters().await {
        let Ok(discovered) = adapter.discover().await else {
            continue;
        };
        if let Some(plugin) = discovered.into_iter().find(|plugin| plugin.id == plugin_id) {
            return Ok(Some((adapter, plugin, format)));
        }
    }
    Ok(None)
}

async fn find_native_descriptor(
    adapter: &plugins::OfficialCliNativePluginAdapter,
    plugin_id: &str,
) -> Result<NativePluginDescriptor, ApplicationError> {
    adapter
        .discover()
        .await
        .map_err(plugin_error)?
        .into_iter()
        .find(|plugin| plugin.id == plugin_id)
        .ok_or_else(|| ApplicationError::not_found(plugin_id.to_owned()))
}

fn native_plugin_item(
    plugin: NativePluginDescriptor,
    format: &str,
    capabilities: plugins::NativeAdapterCapabilities,
) -> Value {
    let skills = discover_native_skills(&plugin.path);
    let mcp_servers = native_mcp_names(&plugin.path);
    let source_kind = match plugin.ecosystem {
        plugins::NativeEcosystem::Codex => "codex_native",
        plugins::NativeEcosystem::ClaudeCode => "claude_code_native",
    };
    json!({
        "id": plugin.id,
        "publisher": Value::Null,
        "packageDigest": Value::Null,
        "updatePackageDigest": Value::Null,
        "name": plugin.name,
        "version": plugin.version.unwrap_or_else(|| "unknown".to_owned()),
        "description": Value::Null,
        "enabled": plugin.enabled.unwrap_or(false),
        "builtin": false,
        "sourceKind": source_kind,
        "sourcePath": plugin.path.to_string_lossy(),
        "formats": [format],
        "skills": skills,
        "runtimes": [],
        "warnings": [],
        "permissions": [],
        "permissionDelta": [],
        "mcpCount": mcp_servers.len(),
        "mcpServers": mcp_servers,
        "hooks": discover_native_resources(&plugin.path, "hooks"),
        "workflows": discover_native_resources(&plugin.path, "workflows"),
        "invocationCount": 0,
        "invocations": [],
        "appContributions": [],
        "nativeManaged": true,
        "enableSupported": capabilities.enable,
        "updateSupported": capabilities.update,
        "rollbackSupported": false,
        "uninstallSupported": capabilities.uninstall,
        "sourceOrigin": Value::Null,
        "sourceRef": Value::Null,
        "sourceSha": Value::Null,
        "sourceLocked": false,
        "sourceShowTree": Value::Null,
    })
}

fn discover_native_skills(root: &Path) -> Vec<Value> {
    let Ok(entries) = std::fs::read_dir(root.join("skills")) else {
        return Vec::new();
    };
    let mut skills = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let skill = entry.path().join("SKILL.md");
            skill.is_file().then(|| {
                json!({
                    "id": entry.file_name().to_string_lossy(),
                    "path": skill
                        .strip_prefix(root)
                        .unwrap_or(&skill)
                        .to_string_lossy(),
                })
            })
        })
        .collect::<Vec<_>>();
    skills.sort_by(|left, right| left["id"].as_str().cmp(&right["id"].as_str()));
    skills
}

fn discover_native_resources(root: &Path, directory: &str) -> Vec<Value> {
    fn visit(
        root: &Path,
        current: &Path,
        directory: &str,
        depth: usize,
        resources: &mut Vec<Value>,
    ) {
        if depth > 6 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(current) else {
            return;
        };
        let prefix = format!("{directory}/");
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.is_dir() {
                visit(root, &path, directory, depth + 1, resources);
                continue;
            }
            let relative = path.strip_prefix(root).unwrap_or(&path);
            let id = relative
                .with_extension("")
                .to_string_lossy()
                .replace('\\', "/");
            resources.push(json!({
                "id": id.trim_start_matches(&prefix),
                "path": relative.to_string_lossy().replace('\\', "/"),
            }));
        }
    }

    let mut resources = Vec::new();
    visit(root, &root.join(directory), directory, 0, &mut resources);
    resources.sort_by(|left, right| left["id"].as_str().cmp(&right["id"].as_str()));
    resources
}

fn read_native_mcp(root: &Path) -> Result<Option<Value>, ApplicationError> {
    let path = root.join(".mcp.json");
    if !path.is_file() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&path).map_err(internal_error)?;
    serde_json::from_str(&content).map(Some).map_err(|error| {
        ApplicationError::bad_request(format!("invalid native MCP configuration: {error}"))
    })
}

fn native_mcp_names(root: &Path) -> Vec<String> {
    match read_native_mcp(root) {
        Ok(Some(value)) => {
            let mut names = value
                .get("mcpServers")
                .unwrap_or(&value)
                .as_object()
                .map(|servers| servers.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            names.sort();
            names
        }
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    #[test]
    fn native_plugin_item_marks_cli_plugins_as_native_managed() {
        let item = native_plugin_item(
            NativePluginDescriptor {
                id: "demo".into(),
                name: "Demo".into(),
                version: Some("1.0.0".into()),
                ecosystem: plugins::NativeEcosystem::Codex,
                path: PathBuf::from("/tmp/demo"),
                enabled: Some(true),
            },
            "codex",
            plugins::NativeAdapterCapabilities {
                discover: true,
                install: false,
                enable: false,
                update: false,
                uninstall: true,
            },
        );
        assert_eq!(item["id"], "demo");
        assert_eq!(item["sourceKind"], "codex_native");
        assert_eq!(item["nativeManaged"], true);
        assert_eq!(item["enableSupported"], false);
        assert_eq!(item["uninstallSupported"], true);
        assert_eq!(item["formats"], json!(["codex"]));
    }
}
