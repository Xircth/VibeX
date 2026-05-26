use std::{ffi::OsString, path::PathBuf, time::Duration};

use serde::{Deserialize, Serialize};

use crate::error::AppError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemMaintenanceStatus {
    pub app: AppReleaseStatus,
    pub npm: RuntimeStatus,
    pub tools: Vec<LocalToolStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppReleaseStatus {
    pub current_version: String,
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub release_url: Option<String>,
    pub repository: Option<String>,
    pub checked: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeStatus {
    pub name: String,
    pub available: bool,
    pub path: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalToolStatus {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub group_id: String,
    pub user_visible: bool,
    pub executable: String,
    pub npm_package: String,
    pub installed: bool,
    pub executable_path: Option<String>,
    pub installed_version: Option<String>,
    pub latest_version: Option<String>,
    pub minimum_supported_version: Option<String>,
    pub supported: bool,
    pub update_available: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallSystemDependenciesResult {
    pub installed_or_updated: Vec<String>,
    pub skipped: Vec<String>,
    pub status: SystemMaintenanceStatus,
}

#[derive(Debug, Clone, Copy)]
struct ToolSpec {
    id: &'static str,
    label: &'static str,
    kind: &'static str,
    group_id: &'static str,
    user_visible: bool,
    executable: &'static str,
    npm_package: &'static str,
    version_args: &'static [&'static str],
    use_package_metadata_version: bool,
    minimum_supported_version: Option<&'static str>,
}

const TOOL_SPECS: &[ToolSpec] = &[
    ToolSpec {
        id: "claude_cli",
        label: "Claude Code CLI",
        kind: "cli",
        group_id: "claude",
        user_visible: true,
        executable: bin_name("claude"),
        npm_package: "@anthropic-ai/claude-code",
        version_args: &["--version"],
        use_package_metadata_version: false,
        minimum_supported_version: Some("2.1.143"),
    },
    ToolSpec {
        id: "claude_agent_sdk",
        label: "Claude Agent SDK",
        kind: "sdk",
        group_id: "claude",
        user_visible: false,
        executable: "",
        npm_package: "@anthropic-ai/claude-agent-sdk",
        version_args: &[],
        use_package_metadata_version: true,
        minimum_supported_version: Some("0.3.143"),
    },
    ToolSpec {
        id: "claude_acp",
        label: "Claude Code ACP",
        kind: "acp",
        group_id: "claude",
        user_visible: false,
        executable: bin_name("claude-agent-acp"),
        npm_package: "@agentclientprotocol/claude-agent-acp",
        version_args: &["--version"],
        use_package_metadata_version: true,
        minimum_supported_version: None,
    },
    ToolSpec {
        id: "codex_cli",
        label: "Codex CLI",
        kind: "cli",
        group_id: "codex",
        user_visible: true,
        executable: bin_name("codex"),
        npm_package: "@openai/codex",
        version_args: &["--version"],
        use_package_metadata_version: false,
        minimum_supported_version: Some("0.130.0"),
    },
    ToolSpec {
        id: "codex_acp",
        label: "Codex ACP",
        kind: "acp",
        group_id: "codex",
        user_visible: false,
        executable: bin_name("codex-acp"),
        npm_package: "@zed-industries/codex-acp",
        version_args: &["--version"],
        use_package_metadata_version: true,
        minimum_supported_version: None,
    },
    ToolSpec {
        id: "opencode_cli_acp",
        label: "OpenCode CLI",
        kind: "cli_acp",
        group_id: "opencode",
        user_visible: true,
        executable: bin_name("opencode"),
        npm_package: "opencode-ai",
        version_args: &["--version"],
        use_package_metadata_version: false,
        minimum_supported_version: Some("1.15.4"),
    },
    ToolSpec {
        id: "opencode_sdk",
        label: "OpenCode SDK",
        kind: "sdk",
        group_id: "opencode",
        user_visible: false,
        executable: "",
        npm_package: "@opencode-ai/sdk",
        version_args: &[],
        use_package_metadata_version: true,
        minimum_supported_version: Some("1.15.4"),
    },
];

const DEFAULT_UPDATE_REPOSITORY: &str = "vibex/vibex";

const fn bin_name(base: &'static str) -> &'static str {
    #[cfg(windows)]
    {
        match base.as_bytes() {
            b"claude" => "claude.cmd",
            b"claude-agent-acp" => "claude-agent-acp.cmd",
            b"codex" => "codex.cmd",
            b"codex-acp" => "codex-acp.cmd",
            b"opencode" => "opencode.cmd",
            _ => base,
        }
    }
    #[cfg(not(windows))]
    {
        base
    }
}

fn npm_program() -> &'static str {
    if cfg!(windows) { "npm.cmd" } else { "npm" }
}

#[tauri::command]
pub async fn get_system_maintenance_status() -> Result<SystemMaintenanceStatus, AppError> {
    system_maintenance_status().await
}

#[tauri::command]
pub async fn check_app_release() -> Result<AppReleaseStatus, AppError> {
    Ok(check_latest_release().await)
}

#[tauri::command]
pub async fn install_system_dependencies(
    force_update: Option<bool>,
    tool_ids: Option<Vec<String>>,
) -> Result<InstallSystemDependenciesResult, AppError> {
    let force_update = force_update.unwrap_or(false);
    let before = system_maintenance_status().await?;
    if !before.npm.available {
        return Err(AppError::Internal(before.npm.message));
    }
    let requested_groups = selected_tool_groups(tool_ids.as_deref());

    let packages =
        installable_packages_for_status(&before, requested_groups.as_ref(), force_update);

    if packages.is_empty() {
        return Ok(InstallSystemDependenciesResult {
            installed_or_updated: Vec::new(),
            skipped: before.tools.iter().map(|tool| tool.id.clone()).collect(),
            status: before,
        });
    }

    run_npm_install(&packages).await?;
    let package_set = packages
        .iter()
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();
    let status = system_maintenance_status().await?;
    Ok(InstallSystemDependenciesResult {
        installed_or_updated: packages,
        skipped: status
            .tools
            .iter()
            .filter(|tool| {
                tool.installed
                    && !tool.update_available
                    && !TOOL_SPECS
                        .iter()
                        .any(|spec| spec.id == tool.id && package_set.contains(spec.npm_package))
            })
            .map(|tool| tool.id.clone())
            .collect(),
        status,
    })
}

fn selected_tool_groups(tool_ids: Option<&[String]>) -> Option<std::collections::BTreeSet<String>> {
    let tool_ids = tool_ids?;
    if tool_ids.is_empty() {
        return None;
    }

    let groups = tool_ids
        .iter()
        .filter_map(|tool_id| {
            TOOL_SPECS
                .iter()
                .find(|spec| spec.id == tool_id || spec.group_id == tool_id)
                .map(|spec| spec.group_id.to_string())
        })
        .collect::<std::collections::BTreeSet<_>>();

    (!groups.is_empty()).then_some(groups)
}

fn installable_packages_for_status(
    status: &SystemMaintenanceStatus,
    requested_groups: Option<&std::collections::BTreeSet<String>>,
    force_update: bool,
) -> Vec<String> {
    status
        .tools
        .iter()
        .filter(|tool| {
            requested_groups.is_none_or(|groups| groups.contains(&tool.group_id))
                && tool.user_visible
                && (!tool.installed
                    || !tool.supported
                    || tool.update_available
                    || (force_update && tool.latest_version.is_some()))
        })
        .map(|tool| tool.npm_package.clone())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect()
}

async fn system_maintenance_status() -> Result<SystemMaintenanceStatus, AppError> {
    let app = check_latest_release().await;
    let npm = runtime_status(npm_program()).await;
    let mut tools = Vec::with_capacity(TOOL_SPECS.len());
    for spec in TOOL_SPECS {
        tools.push(check_tool_status(*spec).await);
    }

    Ok(SystemMaintenanceStatus { app, npm, tools })
}

async fn runtime_status(name: &str) -> RuntimeStatus {
    match resolve_program(name).await {
        Ok(path) => RuntimeStatus {
            name: name.to_string(),
            available: true,
            path: Some(path.display().to_string()),
            message: format!("Found {name}"),
        },
        Err(error) => RuntimeStatus {
            name: name.to_string(),
            available: false,
            path: None,
            message: error.to_string(),
        },
    }
}

async fn check_tool_status(spec: ToolSpec) -> LocalToolStatus {
    let executable_path = if spec.executable.is_empty() {
        None
    } else {
        resolve_program(spec.executable).await.ok()
    };
    let latest_version = npm_package_latest_version(spec.npm_package)
        .await
        .ok()
        .flatten();
    let installed_version = if spec.executable.is_empty() && spec.use_package_metadata_version {
        global_npm_package_version(spec.npm_package)
            .await
            .ok()
            .flatten()
    } else {
        match executable_path.as_ref() {
            Some(path) => detect_tool_version(spec, path).await.ok().flatten(),
            None => None,
        }
    };

    let update_available = match (&installed_version, &latest_version) {
        (Some(current), Some(latest)) => version_is_newer(latest, current),
        _ => false,
    };
    let supported = match (&installed_version, spec.minimum_supported_version) {
        (Some(current), Some(minimum)) => !version_is_newer(minimum, current),
        (None, Some(_)) => false,
        _ => executable_path.is_some() || spec.executable.is_empty() && installed_version.is_some(),
    };

    let installed = if spec.executable.is_empty() {
        installed_version.is_some()
    } else {
        executable_path.is_some()
    };

    LocalToolStatus {
        id: spec.id.to_string(),
        label: spec.label.to_string(),
        kind: spec.kind.to_string(),
        group_id: spec.group_id.to_string(),
        user_visible: spec.user_visible,
        executable: spec.executable.to_string(),
        npm_package: spec.npm_package.to_string(),
        installed,
        executable_path: executable_path.map(|path| path.display().to_string()),
        installed_version,
        latest_version,
        minimum_supported_version: spec.minimum_supported_version.map(str::to_string),
        supported,
        update_available,
        error: None,
    }
}

async fn detect_tool_version(
    spec: ToolSpec,
    executable: &PathBuf,
) -> Result<Option<String>, AppError> {
    if spec.use_package_metadata_version
        && let Some(version) = global_npm_package_version(spec.npm_package).await?
    {
        return Ok(Some(version));
    }

    let mut command = utils::process::new_hidden_tokio_command(executable, spec.version_args);
    let output = tokio::time::timeout(Duration::from_secs(10), command.output())
        .await
        .map_err(|_| AppError::Internal(format!("Timed out running {}", spec.executable)))?
        .map_err(|error| {
            AppError::Internal(format!(
                "Failed to run {} version: {error}",
                spec.executable
            ))
        })?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !stdout.is_empty() {
            return Ok(Some(first_version_like_token(&stdout)));
        }
    }

    global_npm_package_version(spec.npm_package).await
}

async fn resolve_program(program: &str) -> Result<PathBuf, AppError> {
    let program = program.to_string();
    tokio::task::spawn_blocking({
        let program = program.clone();
        move || which::which(program)
    })
    .await
    .map_err(|error| AppError::Internal(format!("Failed to resolve {program}: {error}")))?
    .map_err(|error| AppError::Internal(format!("{program} not found in PATH: {error}")))
}

async fn run_npm_install(packages: &[String]) -> Result<(), AppError> {
    let npm = resolve_program(npm_program()).await?;
    let mut args = vec!["install".to_string(), "-g".to_string()];
    args.extend(packages.iter().map(|package| format!("{package}@latest")));

    let mut command = utils::process::new_hidden_tokio_command(&npm, &args);
    let output = command.output().await.map_err(|error| {
        AppError::Internal(format!(
            "Failed to run npm install for local tools: {error}"
        ))
    })?;

    if output.status.success() {
        Ok(())
    } else {
        Err(AppError::Internal(
            utils::process::command_output_detail(&output)
                .map(|detail| format!("npm install failed for local tools: {detail}"))
                .unwrap_or_else(|| "npm install failed for local tools".to_string()),
        ))
    }
}

async fn npm_package_latest_version(package_name: &str) -> Result<Option<String>, AppError> {
    let npm = resolve_program(npm_program()).await?;
    let mut command = utils::process::new_hidden_tokio_command(
        &npm,
        ["view", package_name, "version", "--silent"],
    );
    let output = tokio::time::timeout(Duration::from_secs(20), command.output())
        .await
        .map_err(|_| {
            AppError::Internal(format!("Timed out checking {package_name} latest version"))
        })?
        .map_err(|error| {
            AppError::Internal(format!(
                "Failed to check {package_name} latest version: {error}"
            ))
        })?;

    if !output.status.success() {
        return Ok(None);
    }

    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok((!version.is_empty()).then_some(version))
}

async fn global_npm_package_version(package_name: &str) -> Result<Option<String>, AppError> {
    let npm = resolve_program(npm_program()).await?;
    let mut command = utils::process::new_hidden_tokio_command(&npm, ["root", "-g"]);
    let output = command.output().await.map_err(|error| {
        AppError::Internal(format!("Failed to locate npm global root: {error}"))
    })?;
    if !output.status.success() {
        return Ok(None);
    }

    let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if root.is_empty() {
        return Ok(None);
    }

    let package_json = package_name
        .split('/')
        .fold(PathBuf::from(root), |path, segment| path.join(segment))
        .join("package.json");
    let content = match tokio::fs::read_to_string(package_json).await {
        Ok(content) => content,
        Err(_) => return Ok(None),
    };
    let value: serde_json::Value = serde_json::from_str(&content)
        .map_err(|error| AppError::Internal(format!("Invalid npm package metadata: {error}")))?;
    Ok(value
        .get("version")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string()))
}

async fn check_latest_release() -> AppReleaseStatus {
    let current_version = utils::version::APP_VERSION.to_string();
    let repository = update_repository();
    let Some(repository) = repository else {
        return AppReleaseStatus {
            current_version,
            latest_version: None,
            update_available: false,
            release_url: None,
            repository: None,
            checked: false,
            error: Some("No GitHub repository configured for release checks".to_string()),
        };
    };

    let url = format!("https://api.github.com/repos/{repository}/releases/latest");
    let client = reqwest::Client::new();
    let response = match client
        .get(url)
        .header(reqwest::header::USER_AGENT, "VibeX")
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            return AppReleaseStatus {
                current_version,
                latest_version: None,
                update_available: false,
                release_url: None,
                repository: Some(repository),
                checked: false,
                error: Some(error.to_string()),
            };
        }
    };

    if !response.status().is_success() {
        return AppReleaseStatus {
            current_version,
            latest_version: None,
            update_available: false,
            release_url: None,
            repository: Some(repository),
            checked: false,
            error: Some(format!(
                "GitHub release check returned {}",
                response.status()
            )),
        };
    }

    #[derive(Deserialize)]
    struct GitHubRelease {
        tag_name: String,
        html_url: String,
    }

    let release = match response.json::<GitHubRelease>().await {
        Ok(release) => release,
        Err(error) => {
            return AppReleaseStatus {
                current_version,
                latest_version: None,
                update_available: false,
                release_url: None,
                repository: Some(repository),
                checked: false,
                error: Some(error.to_string()),
            };
        }
    };

    let latest_version = release.tag_name.trim_start_matches('v').to_string();
    let update_available = version_is_newer(&latest_version, &current_version);
    AppReleaseStatus {
        current_version,
        latest_version: Some(latest_version),
        update_available,
        release_url: Some(release.html_url),
        repository: Some(repository),
        checked: true,
        error: None,
    }
}

fn update_repository() -> Option<String> {
    std::env::var("VIBEX_UPDATE_REPO")
        .ok()
        .and_then(|value| normalize_github_repo(&value))
        .or_else(git_remote_repository)
        .or_else(|| Some(DEFAULT_UPDATE_REPOSITORY.to_string()))
}

fn git_remote_repository() -> Option<String> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .to_path_buf();
    let output = utils::process::new_hidden_std_command(
        "git",
        [
            OsString::from("-C"),
            root.into_os_string(),
            OsString::from("config"),
            OsString::from("--get"),
            OsString::from("remote.origin.url"),
        ],
    )
    .output()
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let remote = String::from_utf8_lossy(&output.stdout).trim().to_string();
    normalize_github_repo(&remote)
}

fn normalize_github_repo(input: &str) -> Option<String> {
    let trimmed = input.trim().trim_end_matches(".git");
    if trimmed.is_empty() {
        return None;
    }
    if let Some(rest) = trimmed.strip_prefix("https://github.com/") {
        return repo_pair(rest);
    }
    if let Some(rest) = trimmed.strip_prefix("http://github.com/") {
        return repo_pair(rest);
    }
    if let Some(rest) = trimmed.strip_prefix("git@github.com:") {
        return repo_pair(rest);
    }
    if trimmed.split('/').count() == 2 {
        return repo_pair(trimmed);
    }
    None
}

fn repo_pair(value: &str) -> Option<String> {
    let mut parts = value.split('/');
    let owner = parts.next()?.trim();
    let repo = parts.next()?.trim();
    if owner.is_empty() || repo.is_empty() || parts.next().is_some() {
        None
    } else {
        Some(format!("{owner}/{repo}"))
    }
}

fn version_is_newer(latest: &str, current: &str) -> bool {
    let latest_parts = numeric_version_parts(latest);
    let current_parts = numeric_version_parts(current);
    latest_parts > current_parts
}

fn numeric_version_parts(value: &str) -> Vec<u64> {
    value
        .trim()
        .trim_start_matches('v')
        .split(|ch: char| !ch.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .filter_map(|part| part.parse::<u64>().ok())
        .collect()
}

fn first_version_like_token(output: &str) -> String {
    output
        .split_whitespace()
        .find(|token| token.chars().any(|ch| ch.is_ascii_digit()))
        .unwrap_or(output)
        .trim_start_matches('v')
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_github_remote_urls() {
        assert_eq!(
            normalize_github_repo("https://github.com/acme/project.git"),
            Some("acme/project".to_string())
        );
        assert_eq!(
            normalize_github_repo("git@github.com:acme/project.git"),
            Some("acme/project".to_string())
        );
        assert_eq!(
            normalize_github_repo("acme/project"),
            Some("acme/project".to_string())
        );
    }

    #[test]
    fn compares_numeric_versions() {
        assert!(version_is_newer("v0.2.0", "0.1.9"));
        assert!(!version_is_newer("0.1.8", "0.1.8"));
        assert!(!version_is_newer("0.1.7", "0.1.8"));
    }

    #[test]
    fn maps_requested_cli_to_dependency_group() {
        assert_eq!(
            selected_tool_groups(Some(&["codex_cli".to_string()]))
                .unwrap()
                .into_iter()
                .collect::<Vec<_>>(),
            vec!["codex".to_string()]
        );
        assert_eq!(
            selected_tool_groups(Some(&["codex".to_string()]))
                .unwrap()
                .into_iter()
                .collect::<Vec<_>>(),
            vec!["codex".to_string()]
        );
    }

    #[test]
    fn install_candidates_ignore_hidden_sdk_and_acp_tools() {
        let status = SystemMaintenanceStatus {
            app: AppReleaseStatus {
                current_version: "0.1.8".to_string(),
                latest_version: None,
                update_available: false,
                release_url: None,
                repository: None,
                checked: false,
                error: None,
            },
            npm: RuntimeStatus {
                name: "npm".to_string(),
                available: true,
                path: Some("npm".to_string()),
                message: "ok".to_string(),
            },
            tools: vec![
                LocalToolStatus {
                    id: "opencode_cli_acp".to_string(),
                    label: "OpenCode CLI".to_string(),
                    kind: "cli_acp".to_string(),
                    group_id: "opencode".to_string(),
                    user_visible: true,
                    executable: "opencode".to_string(),
                    npm_package: "opencode-ai".to_string(),
                    installed: true,
                    executable_path: Some("opencode".to_string()),
                    installed_version: Some("1.15.4".to_string()),
                    latest_version: Some("1.15.4".to_string()),
                    minimum_supported_version: Some("1.15.4".to_string()),
                    supported: true,
                    update_available: false,
                    error: None,
                },
                LocalToolStatus {
                    id: "opencode_sdk".to_string(),
                    label: "OpenCode SDK".to_string(),
                    kind: "sdk".to_string(),
                    group_id: "opencode".to_string(),
                    user_visible: false,
                    executable: "".to_string(),
                    npm_package: "@opencode-ai/sdk".to_string(),
                    installed: false,
                    executable_path: None,
                    installed_version: None,
                    latest_version: None,
                    minimum_supported_version: Some("1.15.4".to_string()),
                    supported: false,
                    update_available: false,
                    error: None,
                },
            ],
        };
        let groups = selected_tool_groups(Some(&["opencode_cli_acp".to_string()])).unwrap();

        assert!(installable_packages_for_status(&status, Some(&groups), false).is_empty());
    }

    #[test]
    fn claude_sdk_is_checked_as_hidden_global_dependency() {
        let sdk = TOOL_SPECS
            .iter()
            .find(|spec| spec.id == "claude_agent_sdk")
            .expect("Claude Agent SDK spec should exist");

        assert_eq!(sdk.group_id, "claude");
        assert!(!sdk.user_visible);
        assert!(sdk.use_package_metadata_version);
        assert!(sdk.executable.is_empty());
        assert_eq!(sdk.npm_package, "@anthropic-ai/claude-agent-sdk");
        assert_eq!(sdk.minimum_supported_version, Some("0.3.143"));
    }

    #[test]
    fn opencode_sdk_is_checked_as_hidden_global_dependency() {
        let sdk = TOOL_SPECS
            .iter()
            .find(|spec| spec.id == "opencode_sdk")
            .expect("OpenCode SDK spec should exist");

        assert_eq!(sdk.group_id, "opencode");
        assert!(!sdk.user_visible);
        assert!(sdk.use_package_metadata_version);
        assert!(sdk.executable.is_empty());
        assert_eq!(sdk.npm_package, "@opencode-ai/sdk");
        assert_eq!(sdk.minimum_supported_version, Some("1.15.4"));
    }
}
