use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::Duration,
};

use api_types::{GrokPluginSummaryView, GrokPluginView};
use serde_json::Value;

const PLUGIN_OPERATION_TIMEOUT: Duration = Duration::from_secs(180);

pub fn resolve_home(user_home: &Path, environment: &HashMap<String, String>) -> PathBuf {
    environment
        .get("GROK_HOME")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| expand_home(user_home, value))
        .or_else(|| {
            std::env::var("GROK_HOME")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| user_home.join(".grok"))
}

pub async fn list_plugins(
    user_home: &Path,
    environment: &HashMap<String, String>,
) -> Result<GrokPluginSummaryView, String> {
    let home = resolve_home(user_home, environment);
    if let Some(program) = resolve_grok(user_home, environment, &home) {
        match list_via_cli(&program, &home).await {
            Ok(plugins) => {
                return Ok(GrokPluginSummaryView {
                    home: home.display().to_string(),
                    plugins,
                });
            }
            Err(error) => {
                tracing::warn!(%error, "grok plugin list failed; reading installed-plugins registry");
            }
        }
    }
    Ok(GrokPluginSummaryView {
        plugins: list_from_registry(&home)?,
        home: home.display().to_string(),
    })
}

pub async fn add_plugin(
    user_home: &Path,
    environment: &HashMap<String, String>,
    spec: &str,
) -> Result<GrokPluginSummaryView, String> {
    let spec = validate_install_spec(spec)?;
    let home = resolve_home(user_home, environment);
    let program = resolve_grok(user_home, environment, &home)
        .ok_or_else(|| "未找到 grok；安装 Grok Build 后才能管理插件".to_string())?;
    run_grok(
        &program,
        &home,
        &["plugin", "install", spec.as_str(), "--trust"],
    )
    .await?;
    list_plugins(user_home, environment).await
}

pub async fn remove_plugin(
    user_home: &Path,
    environment: &HashMap<String, String>,
    name: &str,
) -> Result<GrokPluginSummaryView, String> {
    let name = validate_plugin_name(name)?;
    let home = resolve_home(user_home, environment);
    let program = resolve_grok(user_home, environment, &home)
        .ok_or_else(|| "未找到 grok；安装 Grok Build 后才能管理插件".to_string())?;
    run_grok(
        &program,
        &home,
        &["plugin", "uninstall", name.as_str(), "--confirm"],
    )
    .await?;
    list_plugins(user_home, environment).await
}

fn resolve_grok(
    user_home: &Path,
    environment: &HashMap<String, String>,
    grok_home: &Path,
) -> Option<PathBuf> {
    environment
        .get("GROK_PATH")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| expand_home(user_home, value))
        .filter(|path| path.is_file())
        .or_else(|| {
            let candidate = grok_home.join("bin").join(grok_binary_name());
            candidate.is_file().then_some(candidate)
        })
        .or_else(|| which::which("grok").ok())
}

fn grok_binary_name() -> &'static str {
    if cfg!(windows) { "grok.exe" } else { "grok" }
}

async fn list_via_cli(program: &Path, home: &Path) -> Result<Vec<GrokPluginView>, String> {
    let output = grok_output(program, home, &["plugin", "list", "--json"]).await?;
    parse_list_json(&output)
}

fn parse_list_json(bytes: &[u8]) -> Result<Vec<GrokPluginView>, String> {
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|error| format!("解析 grok plugin list 失败：{error}"))?;
    let entries = value
        .as_array()
        .cloned()
        .or_else(|| {
            value.as_object().and_then(|object| {
                ["plugins", "installed", "installedPlugins"]
                    .into_iter()
                    .find_map(|key| object.get(key).and_then(Value::as_array).cloned())
            })
        })
        .unwrap_or_default();
    let mut plugins = entries
        .iter()
        .filter_map(project_cli_entry)
        .collect::<Vec<_>>();
    plugins.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(plugins)
}

fn project_cli_entry(entry: &Value) -> Option<GrokPluginView> {
    let name = ["name", "id", "pluginId"]
        .into_iter()
        .find_map(|key| entry.get(key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    Some(GrokPluginView {
        name: name.to_string(),
        version: entry
            .get("version")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        status: entry
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("installed")
            .to_string(),
        path: entry
            .get("path")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        source: entry
            .get("source")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        marketplace: entry
            .get("marketplace")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string),
    })
}

fn list_from_registry(home: &Path) -> Result<Vec<GrokPluginView>, String> {
    let path = home.join("installed-plugins").join("registry.json");
    let Ok(bytes) = std::fs::read(&path) else {
        return Ok(list_from_plugin_dirs(home));
    };
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("解析 Grok 插件注册表失败：{error}"))?;
    let mut plugins = value
        .get("repos")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|repos| {
            repos.iter().flat_map(|(_, repo)| {
                let source = repo
                    .pointer("/kind/url")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let path = repo.get("path").and_then(Value::as_str).map(str::to_string);
                repo.get("plugins")
                    .and_then(Value::as_object)
                    .into_iter()
                    .flat_map(|installed| installed.keys().cloned())
                    .map(move |name| GrokPluginView {
                        name,
                        version: None,
                        status: "installed".to_string(),
                        path: path.clone(),
                        source: source.clone(),
                        marketplace: None,
                    })
            })
        })
        .collect::<Vec<_>>();
    if plugins.is_empty() {
        plugins = list_from_plugin_dirs(home);
    }
    plugins.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(plugins)
}

fn list_from_plugin_dirs(home: &Path) -> Vec<GrokPluginView> {
    let mut plugins = Vec::new();
    for root in [home.join("plugins"), home.join("installed-plugins")] {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if path.file_name().and_then(|name| name.to_str()) == Some("marketplaces") {
                continue;
            }
            if path.join("plugin.json").is_file()
                || path.join("skills").is_dir()
                || path.join(".mcp.json").is_file()
            {
                let name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default()
                    .to_string();
                if name.is_empty() {
                    continue;
                }
                plugins.push(GrokPluginView {
                    name,
                    version: None,
                    status: "installed".to_string(),
                    path: Some(path.display().to_string()),
                    source: None,
                    marketplace: None,
                });
            }
        }
    }
    plugins.sort_by(|left, right| left.name.cmp(&right.name));
    plugins
}

async fn run_grok(program: &Path, home: &Path, args: &[&str]) -> Result<(), String> {
    let output = grok_output(program, home, args).await?;
    let _ = output;
    Ok(())
}

async fn grok_output(program: &Path, home: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let mut command = utils::process::new_hidden_tokio_command(program, args.iter().copied());
    command.env("GROK_HOME", home).kill_on_drop(true);
    let output = tokio::time::timeout(PLUGIN_OPERATION_TIMEOUT, command.output())
        .await
        .map_err(|_| "grok plugin 超时并已终止".to_string())?
        .map_err(|error| format!("启动 grok plugin 失败：{error}"))?;
    if output.status.success() {
        return Ok(output.stdout);
    }
    Err(utils::process::command_output_detail(&output)
        .unwrap_or_else(|| format!("grok plugin 退出码为 {}", output.status)))
}

fn validate_install_spec(spec: &str) -> Result<String, String> {
    let spec = spec.trim();
    if spec.is_empty() {
        return Err("插件来源不能为空".to_string());
    }
    if spec
        .chars()
        .any(|ch| ch.is_whitespace() || matches!(ch, ';' | '|' | '&' | '`' | '$' | '\n' | '\r'))
    {
        return Err("插件来源包含非法字符".to_string());
    }
    if spec.contains("..") {
        return Err("插件来源无效".to_string());
    }
    Ok(spec.to_string())
}

fn validate_plugin_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty()
        || name.contains(['/', '\\', ';', '|', '&', '`', '$', '\n', '\r'])
        || !name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '@'))
    {
        return Err("插件名无效".to_string());
    }
    Ok(name.to_string())
}

fn expand_home(user_home: &Path, value: &str) -> PathBuf {
    if let Some(rest) = value.strip_prefix("~/") {
        user_home.join(rest)
    } else if value == "~" {
        user_home.to_path_buf()
    } else {
        PathBuf::from(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_json_projects_cli_entries() {
        let plugins = parse_list_json(
            br#"[{"status":"installed","name":"ponytail","version":null,"path":"/tmp/ponytail","source":"https://github.com/example/ponytail","marketplace":null}]"#,
        )
        .unwrap();
        assert_eq!(plugins.len(), 1);
        assert_eq!(plugins[0].name, "ponytail");
        assert_eq!(
            plugins[0].source.as_deref(),
            Some("https://github.com/example/ponytail")
        );
    }

    #[test]
    fn registry_projects_installed_plugin_names() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        std::fs::create_dir_all(home.join("installed-plugins")).unwrap();
        std::fs::write(
            home.join("installed-plugins").join("registry.json"),
            r#"{
              "version": 1,
              "repos": {
                "ponytail-3d1ab158": {
                  "kind": {"type":"Git","url":"https://github.com/example/ponytail","commit":"abc"},
                  "path": "/tmp/ponytail",
                  "plugins": {"ponytail": {}}
                }
              }
            }"#,
        )
        .unwrap();
        let plugins = list_from_registry(home).unwrap();
        assert_eq!(plugins[0].name, "ponytail");
        assert_eq!(
            plugins[0].source.as_deref(),
            Some("https://github.com/example/ponytail")
        );
    }

    #[test]
    fn install_spec_rejects_shell_metacharacters() {
        assert!(validate_install_spec("owner/repo").is_ok());
        assert!(validate_install_spec("github.com/owner/repo.git").is_ok());
        assert!(validate_install_spec("owner/repo;rm -rf /").is_err());
        assert!(validate_plugin_name("ponytail").is_ok());
        assert!(validate_plugin_name("../evil").is_err());
    }
}
