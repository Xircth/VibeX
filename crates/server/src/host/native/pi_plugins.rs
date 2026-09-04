use std::{collections::HashMap, path::Path, time::Duration};

use api_types::{PiPluginSummaryView, PiPluginView};
use serde_json::Value;

use super::{pi_configuration, read_json_object_or_empty};

const PLUGIN_OPERATION_TIMEOUT: Duration = Duration::from_secs(180);
const PI_COMMAND_ENV: &str = "PI_ACP_PI_COMMAND";

pub async fn list_plugins(
    pool: &sqlx::SqlitePool,
    home: &Path,
) -> Result<PiPluginSummaryView, String> {
    let env = pi_configuration::read_pi_env(pool).await?;
    let agent_dir = pi_configuration::pi_agent_dir(home, &env);
    let settings = read_json_object_or_empty(&agent_dir.join("settings.json")).await?;
    Ok(PiPluginSummaryView {
        home: agent_dir.display().to_string(),
        plugins: parse_packages(&settings),
    })
}

pub async fn add_plugin(
    pool: &sqlx::SqlitePool,
    home: &Path,
    spec: &str,
) -> Result<PiPluginSummaryView, String> {
    let spec = validate_install_spec(spec)?;
    run_pi(pool, &["install", spec.as_str()]).await?;
    list_plugins(pool, home).await
}

pub async fn remove_plugin(
    pool: &sqlx::SqlitePool,
    home: &Path,
    spec: &str,
) -> Result<PiPluginSummaryView, String> {
    let spec = validate_install_spec(spec)?;
    run_pi(pool, &["remove", spec.as_str()]).await?;
    list_plugins(pool, home).await
}

fn parse_packages(settings: &Value) -> Vec<PiPluginView> {
    let mut plugins = settings
        .get("packages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(project_package)
        .collect::<Vec<_>>();
    plugins.sort_by(|left, right| left.source.cmp(&right.source));
    plugins
}

fn project_package(entry: &Value) -> Option<PiPluginView> {
    let source = match entry {
        Value::String(source) => source.clone(),
        Value::Object(object) => object.get("source")?.as_str()?.to_string(),
        _ => return None,
    };
    let source = source.trim();
    if source.is_empty() {
        return None;
    }
    Some(PiPluginView {
        name: display_name(source),
        version: pinned_version(source),
        kind: package_kind(source).to_string(),
        path: None,
        source: source.to_string(),
    })
}

fn display_name(source: &str) -> String {
    if package_kind(source) == "npm" {
        let body = source.strip_prefix("npm:").unwrap_or(source);
        if let Some(rest) = body.strip_prefix('@') {
            let (name, _) = rest.split_once('@').unwrap_or((rest, ""));
            return format!("@{name}");
        }
        return body
            .split_once('@')
            .map(|(name, _)| name)
            .unwrap_or(body)
            .to_string();
    }
    let body = source.strip_prefix("git:").unwrap_or(source);
    let without_ref = body
        .rsplit_once('@')
        .filter(|(head, _)| !head.is_empty() && !head.ends_with(':'))
        .map(|(head, _)| head)
        .unwrap_or(body);
    without_ref
        .rsplit(['/', '\\'])
        .find(|segment| !segment.is_empty())
        .unwrap_or(without_ref)
        .to_string()
}

fn pinned_version(source: &str) -> Option<String> {
    if package_kind(source) == "npm" {
        let body = source.strip_prefix("npm:").unwrap_or(source);
        let version = if let Some(rest) = body.strip_prefix('@') {
            rest.split_once('@').map(|(_, version)| version)
        } else {
            body.split_once('@').map(|(_, version)| version)
        }?;
        return (!version.is_empty()).then(|| version.to_string());
    }
    let body = source.strip_prefix("git:").unwrap_or(source);
    let (head, version) = body.rsplit_once('@')?;
    if head.is_empty() || head.ends_with(':') || version.is_empty() {
        return None;
    }
    Some(version.to_string())
}

fn package_kind(source: &str) -> &'static str {
    if source.starts_with("npm:") {
        return "npm";
    }
    if source.starts_with("git:")
        || source.starts_with("https://")
        || source.starts_with("http://")
        || source.starts_with("ssh://")
        || source.starts_with("git://")
    {
        return "git";
    }
    "path"
}

async fn run_pi(pool: &sqlx::SqlitePool, args: &[&str]) -> Result<(), String> {
    let env = pi_configuration::read_pi_env(pool).await?;
    let program = resolve_pi(&env).ok_or_else(|| {
        "未找到 pi；安装 Pi 或在 Pi Runtime 中指定可执行文件后才能管理插件".to_string()
    })?;
    let mut command = utils::process::new_hidden_tokio_command(&program, args.iter().copied());
    command.kill_on_drop(true);
    let output = tokio::time::timeout(PLUGIN_OPERATION_TIMEOUT, command.output())
        .await
        .map_err(|_| "pi 插件操作超时并已终止".to_string())?
        .map_err(|error| format!("启动 pi 失败：{error}"))?;
    if output.status.success() {
        return Ok(());
    }
    Err(utils::process::command_output_detail(&output)
        .unwrap_or_else(|| format!("pi 退出码为 {}", output.status)))
}

fn resolve_pi(environment: &HashMap<String, String>) -> Option<std::path::PathBuf> {
    environment
        .get(PI_COMMAND_ENV)
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(pi_configuration::resolve_command)
        .or_else(|| which::which("pi").ok())
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn packages_project_string_and_object_sources() {
        let plugins = parse_packages(&json!({
            "packages": [
                "npm:@scope/tools@1.2.3",
                { "source": "git:github.com/user/repo@v1", "skills": ["one"] },
                "https://github.com/user/theme",
                "/opt/local-package"
            ]
        }));
        assert_eq!(plugins.len(), 4);
        assert_eq!(plugins[0].source, "/opt/local-package");
        assert_eq!(plugins[0].kind, "path");
        assert_eq!(plugins[1].source, "git:github.com/user/repo@v1");
        assert_eq!(plugins[1].name, "repo");
        assert_eq!(plugins[1].version.as_deref(), Some("v1"));
        assert_eq!(plugins[1].kind, "git");
        assert_eq!(plugins[2].name, "theme");
        assert_eq!(plugins[2].kind, "git");
        assert_eq!(plugins[3].name, "@scope/tools");
        assert_eq!(plugins[3].version.as_deref(), Some("1.2.3"));
        assert_eq!(plugins[3].kind, "npm");
    }

    #[test]
    fn scoped_npm_package_without_version_keeps_scope() {
        let plugins = parse_packages(&json!({ "packages": ["npm:@foo/bar"] }));
        assert_eq!(plugins[0].name, "@foo/bar");
        assert_eq!(plugins[0].version, None);
    }

    #[test]
    fn install_spec_rejects_shell_metacharacters() {
        assert!(validate_install_spec("npm:@foo/bar@1.0.0").is_ok());
        assert!(validate_install_spec("git:github.com/user/repo").is_ok());
        assert!(validate_install_spec("https://github.com/user/repo").is_ok());
        assert!(validate_install_spec("npm:@foo/bar;rm -rf /").is_err());
        assert!(validate_install_spec("../evil").is_err());
        assert!(validate_install_spec("").is_err());
    }
}
