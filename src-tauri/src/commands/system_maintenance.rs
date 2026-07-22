use std::{ffi::OsString, path::PathBuf, time::Duration};

use agents::{
    AgentDistribution, AgentKind, local_agent_runtime_spec, local_detection::npm_package_name,
    registry_entry,
};
use serde::{Deserialize, Serialize};

use crate::{error::AppError, state::AppState};

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

/// A maintenance-facing projection of the agent registry.  It deliberately
/// contains no package/executable/version literals: those are owned by the
/// `agents` registry so installing, probing, and launching agree on what a
/// local runtime means.
#[derive(Debug, Clone)]
struct ToolSpec {
    agent_type: AgentKind,
    id: String,
    label: String,
    kind: &'static str,
    group_id: String,
    user_visible: bool,
    executable: String,
    /// Unversioned npm name used for status/latest-version lookups.
    npm_package: String,
    /// Exact npm argument used for installation. Both CLI runtimes and ACP
    /// adapters install their publisher's latest release; the registry's
    /// compatibility floor is enforced separately.
    install_package: String,
    version_args: &'static [&'static str],
    minimum_supported_version: Option<String>,
}

/// Which part(s) of an Agent launch pair an npm maintenance request changed.
/// `cli_acp` is intentionally represented as a CLI update only: the same
/// executable is ownership-checked once and then fully verified (including
/// its ACP subcommand) after installation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ChangedAgentPackages {
    agent_type: AgentKind,
    cli_changed: bool,
    separate_acp_changed: bool,
}

fn changed_agent_packages(
    specs: &[ToolSpec],
    package_set: &std::collections::BTreeSet<String>,
) -> Vec<ChangedAgentPackages> {
    let mut changed: Vec<ChangedAgentPackages> = Vec::new();
    for spec in specs
        .iter()
        .filter(|spec| package_set.contains(&spec.install_package))
    {
        let Some(runtime) = local_agent_runtime_spec(spec.agent_type) else {
            continue;
        };
        let index = match changed
            .iter()
            .position(|entry| entry.agent_type == spec.agent_type)
        {
            Some(index) => index,
            None => {
                changed.push(ChangedAgentPackages {
                    agent_type: spec.agent_type,
                    cli_changed: false,
                    separate_acp_changed: false,
                });
                changed.len() - 1
            }
        };
        let entry = &mut changed[index];
        match spec.kind {
            "cli" | "cli_acp" => entry.cli_changed = true,
            "acp" if runtime.acp_program != runtime.cli_program => {
                entry.separate_acp_changed = true
            }
            _ => {}
        }
    }
    changed
}

async fn require_npm_ownership_for_changed_agents(
    changed: &[ChangedAgentPackages],
) -> Result<(), AppError> {
    for changed_agent in changed {
        if changed_agent.cli_changed {
            crate::commands::agent_settings::require_active_cli_to_be_npm_managed(
                changed_agent.agent_type,
            )
            .await?;
        }
        if changed_agent.separate_acp_changed {
            crate::commands::agent_settings::require_active_acp_to_be_npm_managed(
                changed_agent.agent_type,
            )
            .await?;
        }
    }
    Ok(())
}

/// Background dependency updates currently expose the three agents that have
/// shipped a user-facing update flow. Other registry agents are handled by the
/// Agent settings preflight/bootstrap instead of causing unsolicited install
/// prompts at application startup.
const BACKGROUND_MANAGED_AGENTS: &[AgentKind] =
    &[AgentKind::ClaudeCode, AgentKind::Codex, AgentKind::Opencode];

const VERSION_ARGS: &[&str] = &["--version"];

fn tool_specs() -> Vec<ToolSpec> {
    BACKGROUND_MANAGED_AGENTS
        .iter()
        .copied()
        .flat_map(tool_specs_for_agent)
        .collect()
}

fn tool_specs_for_agent(agent_type: AgentKind) -> Vec<ToolSpec> {
    let Some(runtime) = local_agent_runtime_spec(agent_type) else {
        return Vec::new();
    };
    let Some(cli_package) = runtime.npm_package else {
        return Vec::new();
    };

    let entry = registry_entry(agent_type);
    let display_name = entry.name.strip_suffix(" CLI").unwrap_or(&entry.name);
    // Registry ids intentionally use the ACP-facing name for Codex/Claude;
    // stripping that suffix preserves the existing stable maintenance ids.
    let group_id = entry
        .registry_id
        .strip_suffix("-acp")
        .unwrap_or(&entry.registry_id)
        .to_string();
    let shared_cli_and_acp = runtime.acp_program == runtime.cli_program;

    let cli = ToolSpec {
        agent_type,
        id: format!(
            "{group_id}_{}",
            if shared_cli_and_acp { "cli_acp" } else { "cli" }
        ),
        label: format!("{display_name} CLI"),
        kind: if shared_cli_and_acp { "cli_acp" } else { "cli" },
        group_id: group_id.clone(),
        user_visible: true,
        executable: bin_name(runtime.cli_program),
        npm_package: cli_package.to_string(),
        install_package: format!("{cli_package}@latest"),
        version_args: VERSION_ARGS,
        minimum_supported_version: runtime.cli_minimum_supported_version.map(str::to_string),
    };

    if shared_cli_and_acp {
        return vec![cli];
    }

    let AgentDistribution::Npx {
        package,
        minimum_supported_version,
        ..
    } = &entry.distribution
    else {
        // The current maintenance UI can only install npm packages. If a
        // future adapter has a different installer, its normal preflight still
        // remains available; do not invent a second installer here.
        return vec![cli];
    };

    vec![
        cli,
        ToolSpec {
            agent_type,
            id: format!("{group_id}_acp"),
            label: format!("{display_name} ACP"),
            kind: "acp",
            group_id,
            user_visible: false,
            executable: bin_name(runtime.acp_program),
            npm_package: npm_package_name(package),
            install_package: format!("{}@latest", npm_package_name(package)),
            version_args: VERSION_ARGS,
            minimum_supported_version: Some(minimum_supported_version.clone()),
        },
    ]
}

const DEFAULT_UPDATE_REPOSITORY: &str = "vibex/vibex";

fn bin_name(base: &str) -> String {
    #[cfg(windows)]
    {
        format!("{base}.cmd")
    }
    #[cfg(not(windows))]
    {
        base.to_string()
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
    state: tauri::State<'_, AppState>,
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

    let package_set = packages
        .iter()
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();
    let specs = tool_specs();
    let changed = changed_agent_packages(&specs, &package_set);

    // Agent Settings and startup bootstrap use the same global npm prefix.
    // Serialize maintenance updates with those writes so an ACP adapter and
    // its delegated CLI cannot observe partially-updated global shims.
    let npm_mutation = crate::commands::agent_settings::lock_global_npm_mutations().await;
    // Updating npm cannot update an active Homebrew/standalone executable.
    // Fail before mutating the global prefix instead of reporting a package
    // install that leaves VibeX launching the old runtime from PATH.
    require_npm_ownership_for_changed_agents(&changed).await?;
    let install_result = run_npm_install(&packages).await;
    drop(npm_mutation);
    install_result?;
    let pool = state.deployment.db().pool.clone();
    for changed_agent in &changed {
        let verification = crate::commands::agent_settings::local_agent_runtime_changed(
            &pool,
            changed_agent.agent_type,
        )
        .await;
        if changed_agent.cli_changed {
            crate::commands::agent_settings::require_active_cli_to_be_npm_managed(
                changed_agent.agent_type,
            )
            .await?;
        }
        if changed_agent.separate_acp_changed {
            crate::commands::agent_settings::require_active_acp_to_be_npm_managed(
                changed_agent.agent_type,
            )
            .await?;
        }
        crate::commands::agent_settings::require_verified_local_agent_runtime(
            changed_agent.agent_type,
            &verification,
        )?;
    }
    // No post-install capability probe: the next Prepared Session asks the
    // updated local ACP/runtime pair for its own authoritative controls.
    let status = system_maintenance_status().await?;
    Ok(InstallSystemDependenciesResult {
        installed_or_updated: packages,
        skipped: status
            .tools
            .iter()
            .filter(|tool| {
                tool.installed
                    && !tool.update_available
                    && !specs.iter().any(|spec| {
                        spec.id == tool.id && package_set.contains(&spec.install_package)
                    })
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

    let specs = tool_specs();
    let groups = tool_ids
        .iter()
        .filter_map(|tool_id| {
            specs
                .iter()
                .find(|spec| spec.id == *tool_id || spec.group_id == *tool_id)
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
    let specs_by_id = tool_specs()
        .into_iter()
        .map(|spec| (spec.id.clone(), spec))
        .collect::<std::collections::BTreeMap<_, _>>();

    status
        .tools
        .iter()
        .filter(|tool| {
            requested_groups.is_none_or(|groups| groups.contains(&tool.group_id))
                && (!tool.installed
                    || !tool.supported
                    || tool.update_available
                    || (force_update && tool.latest_version.is_some()))
        })
        .filter_map(|tool| {
            specs_by_id
                .get(&tool.id)
                .map(|spec| spec.install_package.clone())
        })
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect()
}

async fn system_maintenance_status() -> Result<SystemMaintenanceStatus, AppError> {
    let app = check_latest_release().await;
    let npm = runtime_status(npm_program()).await;
    let specs = tool_specs();
    let mut tools = Vec::with_capacity(specs.len());
    for spec in &specs {
        tools.push(check_tool_status(spec).await);
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

fn unverified_component_error(
    label: &str,
    path: Option<&PathBuf>,
    version: Option<&str>,
    minimum: Option<&str>,
    probe_error: Option<&str>,
) -> String {
    let mut message = match (path, version, minimum) {
        (None, _, _) => format!("{label} was not found on PATH"),
        (Some(path), Some(version), Some(minimum)) if version_is_newer(minimum, version) => {
            format!(
                "{label} at {} is {version}; minimum supported version is {minimum}",
                path.display()
            )
        }
        (Some(path), Some(version), _) => {
            format!("{label} at {} reported version {version}", path.display())
        }
        (Some(path), None, _) => format!("{label} at {} did not return a version", path.display()),
    };
    if let Some(probe_error) = probe_error.filter(|error| !error.trim().is_empty()) {
        message.push_str(&format!(": {probe_error}"));
    }
    message
}

async fn check_managed_local_tool_status(spec: &ToolSpec) -> LocalToolStatus {
    let verification =
        crate::commands::agent_settings::verify_local_agent_runtime(spec.agent_type).await;
    let (executable_path, installed_version, installed, supported, error) = match spec.kind {
        "cli" => (
            verification.cli.executable.clone(),
            verification.cli.version.clone(),
            verification.cli.executable.is_some(),
            verification.cli.is_supported(),
            (!verification.cli.is_supported()).then(|| {
                unverified_component_error(
                    &format!("{} CLI", spec.label),
                    verification.cli.executable.as_ref(),
                    verification.cli.version.as_deref(),
                    verification.cli.minimum_supported_version.as_deref(),
                    verification.cli.probe_error.as_deref(),
                )
            }),
        ),
        "acp" => (
            verification.acp.executable.clone(),
            verification.acp.version.clone(),
            verification.acp.executable.is_some(),
            verification.acp.is_supported(),
            (!verification.acp.is_supported()).then(|| {
                unverified_component_error(
                    &format!("{} adapter", spec.label),
                    verification.acp.executable.as_ref(),
                    verification.acp.version.as_deref(),
                    verification.acp.minimum_supported_version.as_deref(),
                    verification.acp.probe_error.as_deref(),
                )
            }),
        ),
        "cli_acp" => {
            let pair_error = crate::commands::agent_settings::require_verified_local_agent_runtime(
                spec.agent_type,
                &verification,
            )
            .err()
            .map(|error| error.to_string());
            (
                verification.cli.executable.clone(),
                verification.cli.version.clone(),
                verification.cli.executable.is_some() && verification.acp.executable.is_some(),
                verification.is_supported(),
                pair_error,
            )
        }
        _ => unreachable!("maintenance tool specs have a known kind"),
    };
    let latest_version = npm_package_latest_version(&spec.npm_package)
        .await
        .ok()
        .flatten();
    let update_available = match (&installed_version, &latest_version) {
        (Some(current), Some(latest)) => version_is_newer(latest, current),
        _ => false,
    };

    LocalToolStatus {
        id: spec.id.clone(),
        label: spec.label.clone(),
        kind: spec.kind.to_string(),
        group_id: spec.group_id.clone(),
        user_visible: spec.user_visible,
        executable: spec.executable.clone(),
        npm_package: spec.npm_package.clone(),
        installed,
        executable_path: executable_path.map(|path| path.display().to_string()),
        installed_version,
        latest_version,
        minimum_supported_version: spec.minimum_supported_version.clone(),
        supported,
        update_available,
        error,
    }
}

async fn check_tool_status(spec: &ToolSpec) -> LocalToolStatus {
    if local_agent_runtime_spec(spec.agent_type).is_some() {
        return check_managed_local_tool_status(spec).await;
    }
    let executable_path = if spec.executable.is_empty() {
        None
    } else {
        resolve_program(&spec.executable).await.ok()
    };
    let latest_version = npm_package_latest_version(&spec.npm_package)
        .await
        .ok()
        .flatten();
    let (installed_version, version_error) = match executable_path.as_ref() {
        Some(path) => match detect_tool_version(spec, path).await {
            Ok(version) => (version, None),
            Err(error) => (None, Some(error.to_string())),
        },
        None => (None, None),
    };

    let update_available = match (&installed_version, &latest_version) {
        (Some(current), Some(latest)) => version_is_newer(latest, current),
        _ => false,
    };
    let supported = match (
        &installed_version,
        spec.minimum_supported_version.as_deref(),
    ) {
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
        id: spec.id.clone(),
        label: spec.label.clone(),
        kind: spec.kind.to_string(),
        group_id: spec.group_id.clone(),
        user_visible: spec.user_visible,
        executable: spec.executable.clone(),
        npm_package: spec.npm_package.clone(),
        installed,
        executable_path: executable_path.map(|path| path.display().to_string()),
        installed_version,
        latest_version,
        minimum_supported_version: spec.minimum_supported_version.clone(),
        supported,
        update_available,
        error: version_error,
    }
}

async fn detect_tool_version(
    spec: &ToolSpec,
    executable: &PathBuf,
) -> Result<Option<String>, AppError> {
    let mut command = utils::process::new_hidden_tokio_command(executable, spec.version_args);
    command.kill_on_drop(true);
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

    Err(AppError::Internal(format!(
        "{} at {} did not return a version",
        spec.label,
        executable.display()
    )))
}

async fn resolve_program(program: &str) -> Result<PathBuf, AppError> {
    utils::shell::resolve_executable_path(program)
        .await
        .ok_or_else(|| AppError::Internal(format!("{program} not found in PATH")))
}

async fn run_npm_install(packages: &[String]) -> Result<(), AppError> {
    let npm = resolve_program(npm_program()).await?;
    let mut args = vec!["install".to_string(), "-g".to_string()];
    // `ToolSpec::install_package` already encodes its update policy. Both
    // CLIs and ACP adapters use `@latest`; their respective registry
    // versions are compatibility floors, checked after installation.
    args.extend(packages.iter().cloned());

    let mut command = utils::process::new_hidden_tokio_command(&npm, &args);
    command.kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(120), command.output())
        .await
        .map_err(|_| AppError::Internal("Timed out installing local tools".to_string()))?
        .map_err(|error| {
            AppError::Internal(format!(
                "Failed to run npm install for local tools: {error}"
            ))
        })?;

    if output.status.success() {
        let _ = utils::shell::refresh_process_path_after_install().await;
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

pub(crate) fn update_repository() -> Option<String> {
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
    fn maintenance_specs_are_derived_from_the_runtime_and_adapter_registry() {
        let specs = tool_specs();
        let codex_runtime = local_agent_runtime_spec(AgentKind::Codex).unwrap();
        let codex_cli = specs
            .iter()
            .find(|spec| spec.id == "codex_cli")
            .expect("Codex CLI maintenance spec");
        assert_eq!(codex_cli.executable, bin_name(codex_runtime.cli_program));
        assert_eq!(codex_cli.npm_package, codex_runtime.npm_package.unwrap());
        assert_eq!(
            codex_cli.minimum_supported_version.as_deref(),
            codex_runtime.cli_minimum_supported_version
        );
        assert_eq!(
            codex_cli.install_package,
            format!("{}@latest", codex_runtime.npm_package.unwrap())
        );

        let codex_entry = registry_entry(AgentKind::Codex);
        let AgentDistribution::Npx {
            package,
            minimum_supported_version,
            ..
        } = &codex_entry.distribution
        else {
            panic!("Codex ACP must be npm-distributed")
        };
        let codex_acp = specs
            .iter()
            .find(|spec| spec.id == "codex_acp")
            .expect("Codex ACP maintenance spec");
        assert_eq!(codex_acp.executable, bin_name(codex_runtime.acp_program));
        assert_eq!(codex_acp.npm_package, npm_package_name(package));
        assert_eq!(
            codex_acp.install_package,
            format!("{}@latest", npm_package_name(package))
        );
        assert_eq!(
            codex_acp.minimum_supported_version.as_deref(),
            Some(minimum_supported_version.as_str())
        );

        let opencode = specs
            .iter()
            .filter(|spec| spec.group_id == "opencode")
            .collect::<Vec<_>>();
        assert_eq!(opencode.len(), 1, "OpenCode's CLI is its ACP server");
        assert_eq!(opencode[0].kind, "cli_acp");
    }

    #[test]
    fn maintenance_tracks_embedded_acp_as_part_of_the_cli_runtime_pair() {
        let specs = tool_specs();
        let opencode = specs
            .iter()
            .find(|spec| spec.id == "opencode_cli_acp")
            .expect("OpenCode combined CLI/ACP maintenance spec");
        let packages = [opencode.install_package.clone()]
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>();

        assert_eq!(
            changed_agent_packages(&specs, &packages),
            vec![ChangedAgentPackages {
                agent_type: AgentKind::Opencode,
                cli_changed: true,
                separate_acp_changed: false,
            }],
            "post-install verification must check both `opencode --version` and `opencode acp --version` through the shared runtime pair"
        );
    }

    #[test]
    fn install_candidates_include_hidden_group_dependencies_for_selected_visible_tool() {
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
            tools: vec![LocalToolStatus {
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
            }],
        };
        let groups = selected_tool_groups(Some(&["opencode_cli_acp".to_string()])).unwrap();

        assert_eq!(
            installable_packages_for_status(&status, Some(&groups), false),
            Vec::<String>::new()
        );
    }
}
