use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    time::Duration,
};

use api_types::{OpenCodePluginStatus, OpenCodePluginSummaryView, OpenCodePluginView};

static PLUGIN_OPERATION: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const PLUGIN_OPERATION_TIMEOUT: Duration = Duration::from_secs(120);

pub(super) fn check_plugins(
    config_path: &Path,
    cache_dir: &Path,
) -> Result<OpenCodePluginSummaryView, String> {
    check_plugins_at(config_path.to_path_buf(), cache_dir.to_path_buf())
}

fn check_plugins_at(
    config_path: PathBuf,
    cache_dir: PathBuf,
) -> Result<OpenCodePluginSummaryView, String> {
    if !config_path.exists() {
        return Ok(summary(config_path, cache_dir, Vec::new()));
    }
    let document: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(&config_path)
            .map_err(|error| format!("读取 {} 失败：{error}", config_path.display()))?,
    )
    .map_err(|error| format!("解析 {} 失败：{error}", config_path.display()))?;
    let mut seen = HashSet::new();
    let mut plugins = Vec::new();
    for declared in document
        .get("plugin")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
    {
        let (name, declared_spec) = parse_plugin_spec(declared).ok_or_else(|| {
            format!("OpenCode 插件声明 `{declared}` 无效；仅支持 npm 包名及精确版本或 latest")
        })?;
        if !seen.insert(name.clone()) {
            continue;
        }
        let package_json = cache_dir
            .join("node_modules")
            .join(&name)
            .join("package.json");
        let installed_version = std::fs::read_to_string(package_json)
            .ok()
            .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
            .and_then(|value| value.get("version")?.as_str().map(str::to_string));
        plugins.push(OpenCodePluginView {
            name,
            declared_spec,
            status: if installed_version.is_some() {
                OpenCodePluginStatus::Installed
            } else {
                OpenCodePluginStatus::Missing
            },
            installed_version,
        });
    }
    Ok(summary(config_path, cache_dir, plugins))
}

fn summary(
    config_path: PathBuf,
    cache_dir: PathBuf,
    plugins: Vec<OpenCodePluginView>,
) -> OpenCodePluginSummaryView {
    OpenCodePluginSummaryView {
        config_path: config_path.display().to_string(),
        cache_dir: cache_dir.display().to_string(),
        plugins,
        has_project_config_hint: false,
    }
}

pub(super) async fn install_missing(
    config_path: PathBuf,
    cache_dir: PathBuf,
    names: Option<Vec<String>>,
) -> Result<OpenCodePluginSummaryView, String> {
    let _guard = PLUGIN_OPERATION
        .try_lock()
        .map_err(|_| "另一个 OpenCode 插件操作正在进行".to_string())?;
    let current = check_plugins(&config_path, &cache_dir)?;
    let requested = names.map(|names| names.into_iter().collect::<HashSet<_>>());
    let missing = current
        .plugins
        .iter()
        .filter(|plugin| plugin.status == OpenCodePluginStatus::Missing)
        .filter(|plugin| {
            requested
                .as_ref()
                .is_none_or(|names| names.contains(&plugin.name))
        })
        .collect::<Vec<_>>();
    if let Some(requested) = requested.as_ref()
        && requested
            .iter()
            .any(|name| !current.plugins.iter().any(|plugin| &plugin.name == name))
    {
        return Err("只能安装 opencode.json 中已声明的插件".to_string());
    }
    if !missing.is_empty() {
        let cache_dir = PathBuf::from(&current.cache_dir);
        tokio::fs::create_dir_all(&cache_dir)
            .await
            .map_err(|error| format!("创建 OpenCode 缓存目录失败：{error}"))?;
        let bun = resolve_bun(&cache_dir)?;
        let mut command = utils::process::new_hidden_tokio_command(
            &bun,
            std::iter::once("add")
                .chain(missing.iter().map(|plugin| plugin.declared_spec.as_str())),
        );
        command.current_dir(&cache_dir).kill_on_drop(true);
        let output = tokio::time::timeout(PLUGIN_OPERATION_TIMEOUT, command.output())
            .await
            .map_err(|_| "bun add 超时并已终止".to_string())?
            .map_err(|error| format!("启动 bun 失败：{error}"))?;
        if !output.status.success() {
            return Err(utils::process::command_output_detail(&output)
                .unwrap_or_else(|| format!("bun add 退出码为 {}", output.status)));
        }
    }
    pin_latest_specs(&current).await?;
    check_plugins(&config_path, &cache_dir)
}

pub(super) async fn uninstall(
    config_path: PathBuf,
    cache_dir: PathBuf,
    name: String,
) -> Result<OpenCodePluginSummaryView, String> {
    let _guard = PLUGIN_OPERATION
        .try_lock()
        .map_err(|_| "另一个 OpenCode 插件操作正在进行".to_string())?;
    if name.starts_with("@opencode-ai/") {
        return Err("不能卸载 OpenCode 内部插件".to_string());
    }
    let current = check_plugins(&config_path, &cache_dir)?;
    if !current.plugins.iter().any(|plugin| plugin.name == name) {
        return Err("插件未在 opencode.json 中声明".to_string());
    }
    let config_path = PathBuf::from(&current.config_path);
    let original_config = tokio::fs::read(&config_path)
        .await
        .map_err(|error| format!("读取 OpenCode 配置失败：{error}"))?;
    let mut document: serde_json::Value = serde_json::from_slice(&original_config)
        .map_err(|error| format!("解析 OpenCode 配置失败：{error}"))?;
    if let Some(plugins) = document
        .get_mut("plugin")
        .and_then(serde_json::Value::as_array_mut)
    {
        plugins.retain(|value| {
            value
                .as_str()
                .and_then(parse_plugin_spec)
                .is_none_or(|(plugin_name, _)| plugin_name != name)
        });
    }
    super::write_json_document(&config_path, &document, false)
        .await
        .map_err(|error| error.message)?;

    let cache_dir = PathBuf::from(&current.cache_dir);
    let removal = async {
        let bun = resolve_bun(&cache_dir)?;
        let mut command = utils::process::new_hidden_tokio_command(&bun, ["remove", name.as_str()]);
        command.current_dir(&cache_dir).kill_on_drop(true);
        let output = tokio::time::timeout(PLUGIN_OPERATION_TIMEOUT, command.output())
            .await
            .map_err(|_| "bun remove 超时并已终止".to_string())?
            .map_err(|error| format!("启动 bun 失败：{error}"))?;
        if output.status.success() {
            return Ok(());
        }
        let detail = utils::process::command_output_detail(&output).unwrap_or_default();
        if detail.contains("not found") {
            Ok(())
        } else if detail.is_empty() {
            Err(format!("bun remove 退出码为 {}", output.status))
        } else {
            Err(detail)
        }
    }
    .await;
    if let Err(error) = removal {
        if let Err(rollback) =
            super::write_bytes_document(&config_path, &original_config, false).await
        {
            return Err(format!(
                "{error}；恢复 opencode.json 失败：{}",
                rollback.message
            ));
        }
        return Err(error);
    }
    check_plugins(&config_path, &cache_dir)
}

fn resolve_bun(cache_dir: &std::path::Path) -> Result<PathBuf, String> {
    let bundled = cache_dir
        .join("bin")
        .join(if cfg!(windows) { "bun.exe" } else { "bun" });
    if bundled.is_file() {
        return Ok(bundled);
    }
    which::which("bun")
        .map_err(|_| "未找到 bun；OpenCode 缓存中的 bun 与系统 PATH 均不可用".to_string())
}

async fn pin_latest_specs(current: &OpenCodePluginSummaryView) -> Result<(), String> {
    let pins = current
        .plugins
        .iter()
        .filter(|plugin| spec_has_floating_version(&plugin.declared_spec))
        .filter_map(|plugin| {
            let package_json = PathBuf::from(&current.cache_dir)
                .join("node_modules")
                .join(&plugin.name)
                .join("package.json");
            let version = std::fs::read_to_string(package_json)
                .ok()
                .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
                .and_then(|value| value.get("version")?.as_str().map(str::to_string))?;
            Some((plugin.name.clone(), version))
        })
        .collect::<std::collections::HashMap<_, _>>();
    if pins.is_empty() {
        return Ok(());
    }
    let config_path = PathBuf::from(&current.config_path);
    let mut document: serde_json::Value = serde_json::from_slice(
        &tokio::fs::read(&config_path)
            .await
            .map_err(|error| format!("读取 OpenCode 配置失败：{error}"))?,
    )
    .map_err(|error| format!("解析 OpenCode 配置失败：{error}"))?;
    if let Some(plugins) = document
        .get_mut("plugin")
        .and_then(serde_json::Value::as_array_mut)
    {
        for plugin in plugins {
            if let Some((name, _)) = plugin.as_str().and_then(parse_plugin_spec)
                && let Some(version) = pins.get(&name)
            {
                *plugin = serde_json::Value::String(format!("{name}@{version}"));
            }
        }
    }
    super::write_json_document(&config_path, &document, false)
        .await
        .map_err(|error| error.message)
}

pub(super) fn spec_has_floating_version(spec: &str) -> bool {
    parse_plugin_spec(spec)
        .is_some_and(|(name, declared)| declared == name || declared.ends_with("@latest"))
}

pub(super) fn parse_plugin_spec(spec: &str) -> Option<(String, String)> {
    let spec = spec.trim();
    if spec.is_empty()
        || spec.len() > 256
        || spec.chars().any(char::is_whitespace)
        || spec.chars().any(char::is_control)
    {
        return None;
    }
    let (name, version) = if spec.starts_with('@') {
        let slash = spec.find('/')?;
        let version_at = spec[slash + 1..].find('@').map(|offset| slash + 1 + offset);
        match version_at {
            Some(index) => (&spec[..index], Some(&spec[index + 1..])),
            None => (spec, None),
        }
    } else {
        match spec.split_once('@') {
            Some((name, version)) if !version.contains('@') => (name, Some(version)),
            Some(_) => return None,
            None => (spec, None),
        }
    };
    if !valid_npm_package_name(name)
        || version.is_some_and(|version| !valid_plugin_version(version))
    {
        return None;
    }
    Some((name.to_string(), spec.to_string()))
}

fn valid_npm_package_name(name: &str) -> bool {
    fn valid_segment(segment: &str) -> bool {
        !segment.is_empty()
            && segment.len() <= 128
            && segment
                .bytes()
                .next()
                .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
            && segment.bytes().all(|byte| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || matches!(byte, b'.' | b'_' | b'-' | b'~')
            })
    }

    if let Some(scoped) = name.strip_prefix('@') {
        let Some((scope, package)) = scoped.split_once('/') else {
            return false;
        };
        !package.contains('/') && valid_segment(scope) && valid_segment(package)
    } else {
        !name.contains('/') && valid_segment(name)
    }
}

fn valid_plugin_version(version: &str) -> bool {
    static EXACT_VERSION: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    version == "latest"
        || EXACT_VERSION
            .get_or_init(|| {
                regex::Regex::new(
                    r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$",
                )
                .expect("exact semver regex")
            })
            .is_match(version)
}

#[cfg(test)]
mod tests {
    use super::{check_plugins_at, parse_plugin_spec, spec_has_floating_version};

    #[test]
    fn parses_scoped_and_unscoped_plugin_specs() {
        assert_eq!(
            parse_plugin_spec("foo@1.2.3"),
            Some(("foo".to_string(), "foo@1.2.3".to_string()))
        );
        assert_eq!(
            parse_plugin_spec("@scope/name@latest"),
            Some(("@scope/name".to_string(), "@scope/name@latest".to_string()))
        );
        assert!(spec_has_floating_version("@scope/name@latest"));
        assert!(spec_has_floating_version("foo"));
        for invalid in [
            "--cwd=/tmp",
            "file:../plugin",
            "../plugin",
            "https://example.test/plugin.tgz",
            "git+https://example.test/plugin.git",
            "foo@^1.2.3",
            "foo@beta",
            "@scope/name@1.2",
            "UPPER@1.2.3",
        ] {
            assert_eq!(parse_plugin_spec(invalid), None, "accepted {invalid}");
        }
    }

    #[test]
    fn reports_declared_plugins_against_the_opencode_cache() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().join("opencode.json");
        let cache = temp.path().join("cache");
        std::fs::write(&config, r#"{"plugin":["foo@1.2.3","bar@latest"]}"#).unwrap();
        let package = cache.join("node_modules/foo/package.json");
        std::fs::create_dir_all(package.parent().unwrap()).unwrap();
        std::fs::write(package, r#"{"version":"1.2.3"}"#).unwrap();

        let result = check_plugins_at(config, cache).unwrap();

        assert_eq!(
            result.plugins[0].installed_version.as_deref(),
            Some("1.2.3")
        );
        assert_eq!(
            result.plugins[1].status,
            api_types::OpenCodePluginStatus::Missing
        );
    }
}
