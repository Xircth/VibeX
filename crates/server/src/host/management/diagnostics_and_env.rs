#[cfg(not(windows))]
use std::collections::HashSet;
use std::{
    collections::{BTreeMap, HashMap},
    path::{Path, PathBuf},
    time::Duration,
};

use agents::{
    AgentId, BuiltInProfile, BuiltInProfileCatalog, NativeFileMutation, ProfileComponent,
    ProfileManagementActionKind, version_at_least,
};
use api_types::{
    AgentEnvironmentDiagnosticCheckView, AgentEnvironmentDiagnosticLevel,
    AgentEnvironmentDiagnosticSectionView, AgentEnvironmentDiagnosticsView,
    AgentEnvironmentEntryView, AgentEnvironmentPatchRequest, AgentEnvironmentView,
    AgentManagementActionKind, AgentManagementActionReceipt, AgentPreflightItemView,
};
use application::ApplicationError;
use chrono::Utc;
use sha2::{Digest, Sha256};

use super::{
    ResolvedManagementProgram,
    native_preflight::{is_native_engine_profile, vendor_cli_diagnostic_check},
};
use crate::{
    domains::internal_error,
    host::{
        account_flow,
        native::{apply_native_file_mutations, model_providers},
    },
};

pub(super) const DIAGNOSTIC_COMMAND_TIMEOUT: Duration = Duration::from_secs(5);
pub(super) const MAX_AGENT_ENVIRONMENT_ENTRIES: usize = 256;
pub(super) const MAX_AGENT_ENVIRONMENT_NAME_BYTES: usize = 128;
pub(super) const MAX_AGENT_ENVIRONMENT_VALUE_BYTES: usize = 64 * 1024;
pub(super) const MAX_AGENT_ENVIRONMENT_BYTES: usize = 256 * 1024;
pub(super) const SAFE_ENVIRONMENT_KEYS: &[&str] = &[
    "SHELL",
    "LANG",
    "NVM_DIR",
    "FNM_DIR",
    "FNM_MULTISHELL_PATH",
    "VOLTA_HOME",
    "ASDF_DATA_DIR",
    "MISE_DATA_DIR",
    "N_PREFIX",
    "HOMEBREW_PREFIX",
    "npm_config_prefix",
];

pub(super) fn parse_agent_env(
    value: Option<&str>,
) -> Result<HashMap<String, String>, serde_json::Error> {
    value
        .filter(|value| !value.trim().is_empty())
        .map(serde_json::from_str)
        .transpose()
        .map(Option::unwrap_or_default)
}

pub(super) fn project_agent_environment(
    agent_id: AgentId,
    environment: &HashMap<String, String>,
) -> AgentEnvironmentView {
    let ordered: BTreeMap<_, _> = environment
        .iter()
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect();
    AgentEnvironmentView {
        agent_id,
        entries: ordered
            .iter()
            .map(|(name, value)| {
                let secret = is_secret_environment_name(name);
                AgentEnvironmentEntryView {
                    name: name.clone(),
                    value: (!secret).then(|| value.clone()),
                    secret,
                    present: true,
                    masked_value: secret.then(|| "••••••••".to_string()),
                }
            })
            .collect(),
        revision: environment_revision(environment),
    }
}

pub(super) fn environment_revision(environment: &HashMap<String, String>) -> String {
    let ordered: BTreeMap<_, _> = environment
        .iter()
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect();
    let bytes = serde_json::to_vec(&ordered).expect("environment map is serializable");
    format!("{:x}", Sha256::digest(bytes))
}

pub(super) fn validate_agent_environment_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > MAX_AGENT_ENVIRONMENT_NAME_BYTES {
        return Err("环境变量名称长度必须为 1 到 128 字节".to_string());
    }
    let mut bytes = name.bytes();
    let first = bytes.next().expect("non-empty environment name");
    if !(first == b'_' || first.is_ascii_alphabetic())
        || !bytes.all(|byte| byte == b'_' || byte.is_ascii_alphanumeric())
    {
        return Err(format!("环境变量名称 `{name}` 不合法"));
    }
    Ok(())
}

fn is_secret_environment_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    [
        "API_KEY",
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "CREDENTIAL",
        "PRIVATE_KEY",
        "ACCESS_KEY",
    ]
    .iter()
    .any(|marker| upper.contains(marker))
}

pub(super) async fn probe_profile_dependencies(
    profile: &BuiltInProfile,
) -> Vec<AgentPreflightItemView> {
    let mut items = Vec::with_capacity(profile.dependencies.len());
    for dependency in profile.dependencies {
        if matches!(dependency.executable, "node" | "npm" | "uv") {
            continue;
        }
        let path = resolve_on_path(dependency.executable).await;
        let version = match path.as_ref() {
            Some(path) => probe_first_output_line(path, dependency.version_args).await,
            None => None,
        };
        let version_ok = version
            .as_deref()
            .map(|version| dependency_version_ok(dependency.requirement, version))
            .unwrap_or(path.is_some());
        let healthy = path.is_some() && version_ok;
        items.push(AgentPreflightItemView {
            id: format!("dependency.{}", dependency.id),
            label: dependency.label.to_string(),
            status: if healthy {
                "pass".to_string()
            } else if dependency.required {
                "fail".to_string()
            } else {
                "warning".to_string()
            },
            detail: if healthy {
                String::new()
            } else {
                format!(
                    "未满足依赖 `{}` ({})",
                    dependency.executable, dependency.requirement
                )
            },
            version,
            path: path.map(|path| path.display().to_string()),
            source: None,
            repairable: dependency.repairable,
            update_available: false,
            available_version: None,
            update_group: None,
        });
    }
    items
}

pub(crate) async fn discover_profile_acp(agent_id: &AgentId) -> Option<PathBuf> {
    let catalog = BuiltInProfileCatalog::management();
    let profile = catalog.profile(agent_id)?;
    for candidate in profile.external_candidates {
        if !matches!(
            candidate.component,
            ProfileComponent::AcpAdapter | ProfileComponent::CombinedRuntime
        ) {
            continue;
        }
        if let Some(path) = resolve_on_path(candidate.executable).await
            && !agents::launch_program_is_legacy_acp_shim(agent_id, &path)
        {
            return Some(path);
        }
        if is_native_engine_profile(agent_id)
            && let Some(home) = dirs::home_dir()
            && let Some(path) = agents::resolve_native_engine_cli(agent_id.as_str(), &home)
            && !agents::launch_program_is_legacy_acp_shim(agent_id, &path)
        {
            return Some(path);
        }
        if let Some(path) = discover_executable_in_common_locations(candidate.executable)
            && !agents::launch_program_is_legacy_acp_shim(agent_id, &path)
        {
            return Some(path);
        }
    }
    None
}

pub(super) fn discover_executable_in_common_locations(executable: &str) -> Option<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".cargo/bin"));
    }
    #[cfg(windows)]
    {
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            dirs.push(local_app_data.join("Programs").join("Kiro CLI").join("bin"));
            dirs.push(local_app_data.join("Programs").join("Kiro CLI"));
            dirs.push(local_app_data.join("Programs").join("Kiro").join("bin"));
            dirs.push(local_app_data.join("Programs").join("TraeCLI").join("bin"));
        }
        for env_key in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
            if let Some(program_files) = std::env::var_os(env_key).map(PathBuf::from) {
                dirs.push(program_files.join("Kiro-Cli"));
                dirs.push(program_files.join("Kiro CLI"));
                dirs.push(program_files.join("Kiro CLI").join("bin"));
            }
        }
    }
    for dir in dirs {
        for candidate in [
            dir.join(executable),
            dir.join(format!("{executable}.exe")),
            dir.join(format!("{executable}.cmd")),
        ] {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

pub(super) fn management_program_names(action: &agents::ProfileManagementAction) -> String {
    action
        .programs
        .iter()
        .map(|entry| format!("`{}`", entry.program))
        .collect::<Vec<_>>()
        .join(" / ")
}

fn management_environment_assignments(environment: &HashMap<String, String>) -> Vec<String> {
    let mut variables = environment
        .iter()
        .filter(|(key, value)| {
            !value.trim().is_empty()
                && !["KEY", "TOKEN", "SECRET", "PASSWORD", "CREDENTIAL"]
                    .iter()
                    .any(|marker| key.contains(marker))
                && (key.ends_with("_HOME")
                    || key.ends_with("_DIR")
                    || key.ends_with("_BASE_URL")
                    || key.starts_with("XDG_"))
        })
        .collect::<Vec<_>>();
    variables.sort_by_key(|(key, _)| *key);
    #[cfg(not(windows))]
    {
        variables
            .into_iter()
            .map(|(key, value)| format!("{key}={}", shell_quote_management_part(value)))
            .collect()
    }
    #[cfg(windows)]
    {
        variables
            .into_iter()
            .map(|(key, value)| {
                let escaped = value
                    .replace('^', "^^")
                    .replace('%', "%%")
                    .replace('&', "^&")
                    .replace('|', "^|")
                    .replace('<', "^<")
                    .replace('>', "^>");
                format!("set \"{key}={escaped}\"")
            })
            .collect()
    }
}

pub(super) fn executable_matches(path: &Path, program: &str) -> bool {
    path.file_stem()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case(program))
        || path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case(program))
}

pub(super) fn shell_quote_management_part(value: &str) -> String {
    if value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || b"-._/:\\".contains(&byte))
    {
        return value.to_string();
    }
    #[cfg(windows)]
    return format!("\"{}\"", value.replace('"', "\\\""));
    #[cfg(not(windows))]
    return format!("'{}'", value.replace('\'', "'\\''"));
}

pub(super) async fn launch_watched_management_action(
    agent_id: &AgentId,
    action_id: &str,
    environment: &HashMap<String, String>,
    command: &str,
    result_path: Option<&Path>,
) -> Result<(), ApplicationError> {
    let launched = async {
        let command = account_flow::prepare_management_launch(
            agent_id,
            action_id,
            command,
            &management_environment_assignments(environment),
            result_path,
        )
        .await
        .map_err(internal_error)?;
        launch_management_terminal(agent_id, action_id, environment, &command).await
    }
    .await;
    if launched.is_err() && result_path.is_some() {
        account_flow::cancel_account_flow(agent_id);
    }
    launched
}

async fn launch_management_terminal(
    agent_id: &AgentId,
    action_id: &str,
    environment: &HashMap<String, String>,
    command: &str,
) -> Result<(), ApplicationError> {
    if !model_providers::has_synthetic_gate(agent_id) || action_id != "login" {
        return spawn_agent_management_terminal(command)
            .await
            .map_err(internal_error);
    }
    let home =
        dirs::home_dir().ok_or_else(|| ApplicationError::internal("home directory missing"))?;
    let mutations = model_providers::prepare_kimi_dimo_configuration_cleanup(&home, environment)
        .await
        .map_err(internal_error)?;
    apply_config_transition_then(mutations, || spawn_agent_management_terminal(command)).await
}

async fn apply_config_transition_then<F, Fut>(
    mutations: Vec<NativeFileMutation>,
    operation: F,
) -> Result<(), ApplicationError>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = std::io::Result<()>>,
{
    if !mutations.is_empty() {
        apply_native_file_mutations(&mutations)
            .await
            .map_err(internal_error)?;
    }
    if let Err(operation_error) = operation().await {
        let rollback = mutations
            .iter()
            .map(|mutation| NativeFileMutation {
                path: mutation.path.clone(),
                expected: mutation.replacement.clone(),
                replacement: mutation.expected.clone(),
                sensitive: mutation.sensitive,
            })
            .collect::<Vec<_>>();
        return match apply_native_file_mutations(&rollback).await {
            Ok(()) => Err(internal_error(operation_error)),
            Err(rollback_error) => Err(internal_error(format!(
                "{operation_error}；恢复原配置失败：{rollback_error}"
            ))),
        };
    }
    Ok(())
}

async fn spawn_agent_management_terminal(command: &str) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", "cmd", "/K", command])
            .spawn()
            .map(|_| ())
    }
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "tell application \"Terminal\"\nactivate\ndo script \"{}\"\nend tell",
            command.replace('\\', "\\\\").replace('"', "\\\"")
        );
        std::process::Command::new("osascript")
            .args(["-e", &script])
            .spawn()
            .map(|_| ())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let run = format!("{command}; exec $SHELL");
        for terminal in ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"] {
            if utils::shell::resolve_executable_path(terminal)
                .await
                .is_some()
                && std::process::Command::new(terminal)
                    .args(["-e", "sh", "-lc", &run])
                    .spawn()
                    .map(|_| ())
                    .is_ok()
            {
                return Ok(());
            }
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no supported terminal emulator found",
        ))
    }
}

pub(super) fn management_action_kind(
    kind: ProfileManagementActionKind,
) -> AgentManagementActionKind {
    match kind {
        ProfileManagementActionKind::Login => AgentManagementActionKind::Login,
        ProfileManagementActionKind::Logout => AgentManagementActionKind::Logout,
        ProfileManagementActionKind::Setup => AgentManagementActionKind::Setup,
        ProfileManagementActionKind::Subscription => AgentManagementActionKind::Subscription,
    }
}

pub(super) async fn resolve_on_path(executable: &str) -> Option<PathBuf> {
    if executable.trim().is_empty() {
        return None;
    }
    utils::shell::resolve_executable_path(executable).await
}

pub(crate) async fn probe_first_output_line(path: &Path, args: &[&str]) -> Option<String> {
    if args.is_empty() {
        return None;
    }
    let mut command = utils::process::new_hidden_tokio_command(path, args.iter().copied());
    command.kill_on_drop(true);
    let output = tokio::time::timeout(DIAGNOSTIC_COMMAND_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(redact_operation_output)
}

fn redact_operation_output(value: &str) -> String {
    let mut redacted = value.to_string();
    for marker in ["sk-", "key-", "token=", "Bearer "] {
        if let Some(index) = redacted.find(marker) {
            redacted.replace_range(index + marker.len().., "***");
            break;
        }
    }
    redacted
}

pub(super) fn dependency_version_ok(requirement: &str, output: &str) -> bool {
    let requirement = requirement.trim();
    if let Some(min) = requirement.strip_prefix(">=") {
        return version_at_least(output, min.trim());
    }
    if let Some(min) = requirement.strip_prefix('>') {
        return version_at_least(output, min.trim()) && !output.contains(min.trim());
    }
    true
}

#[derive(Debug, Default)]
pub(super) struct TerminalPathProbe {
    pub command_path: Option<String>,
    pub extra_directories: Vec<String>,
    pub note: Option<String>,
}

#[cfg(not(windows))]
pub(super) async fn terminal_path_probe(command: &str, app_path: &[PathBuf]) -> TerminalPathProbe {
    if !command
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return TerminalPathProbe {
            note: Some("unsafe command name rejected".to_string()),
            ..TerminalPathProbe::default()
        };
    }
    let Some(shell) = std::env::var_os("SHELL").map(PathBuf::from) else {
        return TerminalPathProbe {
            note: Some("SHELL is not set".to_string()),
            ..TerminalPathProbe::default()
        };
    };
    if !shell.is_absolute() || !shell.is_file() {
        return TerminalPathProbe {
            note: Some("configured shell is unavailable".to_string()),
            ..TerminalPathProbe::default()
        };
    }
    let script =
        format!("printf 'DIMO_PATH=%s\\n' \"$PATH\"; command -v {command} 2>/dev/null || true");
    let mut process =
        utils::process::new_hidden_tokio_command(&shell, ["-lic", script.as_str()].into_iter());
    process.kill_on_drop(true);
    let output = match tokio::time::timeout(DIAGNOSTIC_COMMAND_TIMEOUT, process.output()).await {
        Ok(Ok(output)) if output.status.success() => output,
        _ => {
            return TerminalPathProbe {
                note: Some("login shell probe failed or timed out".to_string()),
                ..TerminalPathProbe::default()
            };
        }
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut shell_path = Vec::new();
    let mut command_path = None;
    for line in stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        if let Some(path) = line.strip_prefix("DIMO_PATH=") {
            shell_path = std::env::split_paths(path).collect();
        } else if command_path.is_none() && Path::new(line).is_absolute() {
            command_path = Some(line.to_string());
        }
    }
    let app_paths = app_path.iter().collect::<HashSet<_>>();
    TerminalPathProbe {
        command_path,
        extra_directories: shell_path
            .iter()
            .filter(|path| !app_paths.contains(path))
            .map(|path| path.display().to_string())
            .collect(),
        note: None,
    }
}

#[cfg(windows)]
pub(super) async fn terminal_path_probe(
    _command: &str,
    _app_path: &[PathBuf],
) -> TerminalPathProbe {
    TerminalPathProbe {
        note: Some("login shell comparison is unavailable on Windows".to_string()),
        ..TerminalPathProbe::default()
    }
}

pub(super) fn check(
    id: &str,
    label_key: &str,
    value: String,
    level: AgentEnvironmentDiagnosticLevel,
    detail_key: Option<&str>,
) -> AgentEnvironmentDiagnosticCheckView {
    AgentEnvironmentDiagnosticCheckView {
        id: id.to_string(),
        label_key: label_key.to_string(),
        value,
        level,
        detail_key: detail_key.map(ToOwned::to_owned),
    }
}

pub(super) fn section(
    id: &str,
    title_key: &str,
    checks: Vec<AgentEnvironmentDiagnosticCheckView>,
) -> AgentEnvironmentDiagnosticSectionView {
    AgentEnvironmentDiagnosticSectionView {
        id: id.to_string(),
        title_key: title_key.to_string(),
        checks,
    }
}

pub(super) fn render_plain_text(
    agent_id: &AgentId,
    verdict: &str,
    sections: &[AgentEnvironmentDiagnosticSectionView],
    generated_at: &str,
    app_path: &[PathBuf],
) -> String {
    let mut lines = vec![
        "===== Dimo Agent environment diagnostics =====".to_string(),
        format!("agent: {agent_id}"),
        format!("verdict: {verdict}"),
        format!("generated_at: {generated_at}"),
    ];
    for section in sections {
        lines.push(String::new());
        lines.push(format!("[{}]", section.id));
        lines.extend(
            section
                .checks
                .iter()
                .map(|check| format!("{} [{:?}]: {}", check.id, check.level, check.value)),
        );
    }
    lines.push(String::new());
    lines.push("[app PATH]".to_string());
    lines.extend(app_path.iter().map(|path| path.display().to_string()));
    let mut report = lines.join("\n");
    const MAX_REPORT_BYTES: usize = 128 * 1024;
    if report.len() > MAX_REPORT_BYTES {
        let mut boundary = MAX_REPORT_BYTES;
        while boundary > 0 && !report.is_char_boundary(boundary) {
            boundary -= 1;
        }
        report.truncate(boundary);
        report.push_str("\n[report truncated]");
    }
    report
}

#[derive(Debug)]
pub(super) struct InstalledComponent {
    pub kind: String,
    pub path: PathBuf,
    pub version: String,
    pub ownership: String,
    pub exists: bool,
}

pub(super) async fn build_environment_diagnostics(
    agent_id: AgentId,
    profile: &BuiltInProfile,
    installed: &[InstalledComponent],
) -> AgentEnvironmentDiagnosticsView {
    let native_engine = is_native_engine_profile(&agent_id);
    let app_path = std::env::var_os("PATH").unwrap_or_default();
    let app_path_entries = std::env::split_paths(&app_path)
        .filter(|path| !path.as_os_str().is_empty())
        .collect::<Vec<_>>();
    let target_command = profile
        .external_candidates
        .iter()
        .find(|candidate| {
            matches!(
                candidate.component,
                ProfileComponent::AcpAdapter | ProfileComponent::CombinedRuntime
            )
        })
        .or_else(|| profile.external_candidates.first())
        .map(|candidate| candidate.executable)
        .unwrap_or(profile.agent_id.as_str());
    let target_on_app_path = resolve_on_path(target_command)
        .await
        .filter(|path| !agents::launch_program_is_legacy_acp_shim(&agent_id, path))
        .or_else(|| {
            native_engine
                .then(dirs::home_dir)
                .flatten()
                .and_then(|home| agents::resolve_native_engine_cli(agent_id.as_str(), &home))
        });
    let terminal = terminal_path_probe(target_command, &app_path_entries).await;

    let mut runtime_checks = vec![
        check(
            "os_arch",
            "agents.environmentDiagnosticOsArch",
            format!("{} / {}", std::env::consts::OS, std::env::consts::ARCH),
            AgentEnvironmentDiagnosticLevel::Info,
            None,
        ),
        check(
            "app_version",
            "agents.environmentDiagnosticAppVersion",
            env!("CARGO_PKG_VERSION").to_string(),
            AgentEnvironmentDiagnosticLevel::Info,
            None,
        ),
        check(
            "shell",
            "agents.environmentDiagnosticShell",
            std::env::var("SHELL").unwrap_or_else(|_| "N/A".to_string()),
            AgentEnvironmentDiagnosticLevel::Info,
            None,
        ),
        check(
            "app_path",
            "agents.environmentDiagnosticAppPath",
            app_path_entries.len().to_string(),
            AgentEnvironmentDiagnosticLevel::Info,
            Some("agents.environmentDiagnosticAppPathHint"),
        ),
    ];
    runtime_checks.extend(SAFE_ENVIRONMENT_KEYS.iter().filter_map(|key| {
        std::env::var(key).ok().map(|value| {
            check(
                &format!("environment.{key}"),
                "agents.environmentDiagnosticSafeEnvironment",
                format!("{key}={value}"),
                AgentEnvironmentDiagnosticLevel::Info,
                None,
            )
        })
    }));

    let mut dependency_checks = Vec::with_capacity(profile.dependencies.len());
    let mut missing_required_dependency = false;
    for dependency in profile.dependencies {
        let path = resolve_on_path(dependency.executable).await;
        let version = match path.as_ref() {
            Some(path) => probe_first_output_line(path, dependency.version_args).await,
            None => None,
        };
        let version_ok = version
            .as_deref()
            .map(|version| dependency_version_ok(dependency.requirement, version))
            .unwrap_or(path.is_some());
        let healthy = path.is_some() && version_ok;
        if dependency.required && !healthy {
            missing_required_dependency = true;
        }
        let level = if healthy {
            AgentEnvironmentDiagnosticLevel::Ok
        } else if dependency.required {
            AgentEnvironmentDiagnosticLevel::Error
        } else {
            AgentEnvironmentDiagnosticLevel::Warning
        };
        let value = match (version, path) {
            (Some(version), Some(path)) => format!("{version} ({})", path.display()),
            (None, Some(path)) => path.display().to_string(),
            _ => format!("NOT FOUND · {}", dependency.requirement),
        };
        dependency_checks.push(check(
            &format!("dependency.{}", dependency.id),
            &format!("agents.environmentDiagnosticDependency.{}", dependency.id),
            value,
            level,
            (!healthy).then_some(if dependency.required {
                "agents.environmentDiagnosticDependencyRequired"
            } else {
                "agents.environmentDiagnosticDependencyOptional"
            }),
        ));
    }
    if dependency_checks.is_empty() {
        dependency_checks.push(check(
            "dependency.none",
            "agents.environmentDiagnosticNoDependencies",
            "N/A".to_string(),
            AgentEnvironmentDiagnosticLevel::Info,
            None,
        ));
    }

    let managed_launchable = installed.iter().any(|component| {
        component.exists
            && !agents::launch_program_is_legacy_acp_shim(&agent_id, &component.path)
            && matches!(component.kind.as_str(), "acp_adapter" | "combined_runtime")
    });
    let launchable = managed_launchable || target_on_app_path.is_some();
    let mut installation_checks = installed
        .iter()
        .map(|component| {
            let is_legacy_shim =
                agents::launch_program_is_legacy_acp_shim(&agent_id, &component.path);
            check(
                &format!("component.{}", component.kind),
                &format!("agents.environmentDiagnosticComponent.{}", component.kind),
                format!(
                    "{} · {} · {}",
                    component.version,
                    component.ownership,
                    component.path.display()
                ),
                if is_legacy_shim {
                    if launchable {
                        AgentEnvironmentDiagnosticLevel::Warning
                    } else {
                        AgentEnvironmentDiagnosticLevel::Error
                    }
                } else if component.exists {
                    AgentEnvironmentDiagnosticLevel::Ok
                } else {
                    AgentEnvironmentDiagnosticLevel::Error
                },
                (!component.exists).then_some("agents.environmentDiagnosticComponentMissing"),
            )
        })
        .collect::<Vec<_>>();
    installation_checks.push(check(
        "target_command",
        "agents.environmentDiagnosticTargetCommand",
        target_on_app_path
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| {
                if managed_launchable {
                    "user environment".to_string()
                } else {
                    "NOT RESOLVED".to_string()
                }
            }),
        if launchable {
            AgentEnvironmentDiagnosticLevel::Ok
        } else {
            AgentEnvironmentDiagnosticLevel::Error
        },
        managed_launchable.then_some("agents.environmentDiagnosticManagedLaunch"),
    ));
    if let Some(relation) = agents::acp_adapter_relation(agent_id.as_str()) {
        let vendor_cli = agents::resolve_vendor_cli(relation.native_cmd, relation.extra_dirs).await;
        installation_checks.push(vendor_cli_diagnostic_check(
            relation,
            launchable,
            vendor_cli.as_deref(),
        ));
    }

    let terminal_has_gap = target_on_app_path.is_none() && terminal.command_path.is_some();
    let terminal_checks = vec![
        check(
            "terminal_command",
            "agents.environmentDiagnosticTerminalCommand",
            terminal
                .command_path
                .clone()
                .or(terminal.note.clone())
                .unwrap_or_else(|| "NOT RESOLVED".to_string()),
            if terminal_has_gap {
                AgentEnvironmentDiagnosticLevel::Warning
            } else {
                AgentEnvironmentDiagnosticLevel::Info
            },
            terminal_has_gap.then_some("agents.environmentDiagnosticTerminalGap"),
        ),
        check(
            "terminal_extra_paths",
            "agents.environmentDiagnosticTerminalExtraPaths",
            if terminal.extra_directories.is_empty() {
                "none".to_string()
            } else {
                terminal.extra_directories.join("\n")
            },
            if terminal.extra_directories.is_empty() {
                AgentEnvironmentDiagnosticLevel::Ok
            } else {
                AgentEnvironmentDiagnosticLevel::Warning
            },
            (!terminal.extra_directories.is_empty())
                .then_some("agents.environmentDiagnosticTerminalExtraPathsHint"),
        ),
    ];

    let has_invalid_component = installed.iter().any(|component| {
        (!component.exists || agents::launch_program_is_legacy_acp_shim(&agent_id, &component.path))
            && !launchable
    });
    let (verdict_code, verdict_level) = if missing_required_dependency {
        ("dependency_missing", AgentEnvironmentDiagnosticLevel::Error)
    } else if !launchable && terminal_has_gap {
        (
            "terminal_path_gap",
            AgentEnvironmentDiagnosticLevel::Warning,
        )
    } else if !launchable {
        ("agent_not_resolved", AgentEnvironmentDiagnosticLevel::Error)
    } else if has_invalid_component {
        (
            "installation_invalid",
            AgentEnvironmentDiagnosticLevel::Error,
        )
    } else {
        ("ok", AgentEnvironmentDiagnosticLevel::Ok)
    };

    let sections = vec![
        section(
            "runtime",
            "agents.environmentDiagnosticRuntime",
            runtime_checks,
        ),
        section(
            "dependencies",
            "agents.environmentDiagnosticDependencies",
            dependency_checks,
        ),
        section(
            "installation",
            "agents.environmentDiagnosticInstallation",
            installation_checks,
        ),
        section(
            "terminal",
            "agents.environmentDiagnosticTerminal",
            terminal_checks,
        ),
    ];
    let generated_at = Utc::now().to_rfc3339();
    let plain_text = render_plain_text(
        &agent_id,
        verdict_code,
        &sections,
        &generated_at,
        &app_path_entries,
    );
    AgentEnvironmentDiagnosticsView {
        agent_id,
        verdict_code: verdict_code.to_string(),
        verdict_level,
        sections,
        generated_at,
        plain_text,
    }
}

pub(super) async fn resolve_management_program_from_components(
    agent_id: &AgentId,
    program: &str,
    environment: &HashMap<String, String>,
    components: &[String],
) -> Option<PathBuf> {
    if agent_id.as_str() == "pi"
        && program == "pi"
        && let Some(command) = environment.get("PI_ACP_PI_COMMAND")
    {
        let exact = PathBuf::from(command.trim());
        if exact.is_file() {
            return Some(exact);
        }
        if let Some(first) = command.split_whitespace().next() {
            let candidate = PathBuf::from(first);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    for component in components {
        let path = PathBuf::from(component);
        if agents::launch_program_is_legacy_acp_shim(agent_id, &path) {
            continue;
        }
        if executable_matches(&path, program) && path.is_file() {
            return Some(path);
        }
        if let Some(parent) = path.parent() {
            for candidate in [
                parent.join(program),
                parent.join(format!("{program}.cmd")),
                parent.join(format!("{program}.exe")),
            ] {
                if candidate.is_file()
                    && !agents::launch_program_is_legacy_acp_shim(agent_id, &candidate)
                {
                    return Some(candidate);
                }
            }
        }
    }
    if is_native_engine_profile(agent_id)
        && let Some(home) = dirs::home_dir()
        && let Some(path) = agents::resolve_native_engine_cli(agent_id.as_str(), &home)
        && executable_matches(&path, program)
    {
        return Some(path);
    }
    if let Some(relation) = agents::acp_adapter_relation(agent_id.as_str())
        && relation.native_cmd.eq_ignore_ascii_case(program)
        && let Some(path) = agents::resolve_vendor_cli(program, relation.extra_dirs).await
    {
        return Some(path);
    }
    if let Some(path) = utils::shell::resolve_executable_path(program).await
        && !agents::launch_program_is_legacy_acp_shim(agent_id, &path)
    {
        return Some(path);
    }
    discover_executable_in_common_locations(program)
}

pub(super) async fn execute_non_antigravity_action(
    agent_id: &AgentId,
    action: &agents::ProfileManagementAction,
    environment: &HashMap<String, String>,
    resolved_program: Option<ResolvedManagementProgram>,
) -> Result<(), ApplicationError> {
    if let Some(url) = action.url {
        return utils::browser::open_browser(url)
            .await
            .map_err(internal_error);
    }
    let program = resolved_program.ok_or_else(|| {
        ApplicationError::bad_request(format!(
            "未找到 {}；请重新安装或修复此 Agent。",
            management_program_names(action)
        ))
    })?;
    let command = std::iter::once(program.path.display().to_string())
        .chain(program.args)
        .map(|part| shell_quote_management_part(&part))
        .collect::<Vec<_>>()
        .join(" ");
    let watches_account = matches!(
        action.kind,
        ProfileManagementActionKind::Login | ProfileManagementActionKind::Logout
    );
    let result_path = watches_account.then(|| account_flow::account_flow_result_path(agent_id));
    if let Some(result_path) = &result_path {
        let _ = tokio::fs::remove_file(result_path).await;
        account_flow::register_account_flow(agent_id, action.id, action.kind, result_path.clone());
    }
    launch_watched_management_action(
        agent_id,
        action.id,
        environment,
        &command,
        result_path.as_deref(),
    )
    .await
}

pub(super) async fn spawn_antigravity_login_flow(
    agent_id: AgentId,
    action: &agents::ProfileManagementAction,
    mut environment: HashMap<String, String>,
    program: ResolvedManagementProgram,
) -> Result<AgentManagementActionReceipt, ApplicationError> {
    let report = agents::apply_antigravity_launch_env(&mut environment);
    if let (agents::AntigravitySyncStatus::Skipped, Some(reason)) = (report.status, report.reason) {
        return Err(ApplicationError::bad_request(format!(
            "无法写入 Antigravity 登录设置：{reason}"
        )));
    }
    let cwd =
        dirs::home_dir().ok_or_else(|| ApplicationError::internal("home directory missing"))?;
    let result_path = account_flow::account_flow_result_path(&agent_id);
    let _ = tokio::fs::remove_file(&result_path).await;
    account_flow::register_account_flow(&agent_id, action.id, action.kind, result_path.clone());
    let receipt = AgentManagementActionReceipt {
        agent_id,
        action_id: action.id.to_string(),
        launched: true,
    };
    tokio::spawn(async move {
        let outcome = agents::run_antigravity_login(
            &program.path,
            &program.args,
            &environment,
            &cwd,
            agents::ANTIGRAVITY_LOGIN_TIMEOUT,
        )
        .await;
        if let Err(reason) = &outcome {
            tracing::warn!(%reason, "Antigravity sign-in failed");
        }
        let exit_code = i32::from(outcome.is_err());
        let _ = tokio::fs::write(&result_path, format!("{exit_code}\n")).await;
    });
    Ok(receipt)
}

pub(super) fn apply_environment_patch(
    environment: &mut HashMap<String, String>,
    request: AgentEnvironmentPatchRequest,
) -> Result<AgentEnvironmentView, ApplicationError> {
    if request.values.len() > MAX_AGENT_ENVIRONMENT_ENTRIES {
        return Err(ApplicationError::bad_request("单次环境变量更新项过多"));
    }
    if environment_revision(environment) != request.base_revision {
        return Err(ApplicationError::conflict(
            "Agent 环境变量已被其它操作修改，请重新读取后再保存",
        ));
    }
    for (name, value) in request.values {
        validate_agent_environment_name(&name).map_err(ApplicationError::bad_request)?;
        match value {
            Some(value) => {
                if value.len() > MAX_AGENT_ENVIRONMENT_VALUE_BYTES {
                    return Err(ApplicationError::bad_request(format!(
                        "环境变量 `{name}` 的值超过 64 KiB"
                    )));
                }
                environment.insert(name, value);
            }
            None => {
                environment.remove(&name);
            }
        }
    }
    if environment.len() > MAX_AGENT_ENVIRONMENT_ENTRIES {
        return Err(ApplicationError::bad_request(
            "Agent 环境变量不能超过 256 项",
        ));
    }
    let serialized = serde_json::to_string(environment).map_err(internal_error)?;
    if serialized.len() > MAX_AGENT_ENVIRONMENT_BYTES {
        return Err(ApplicationError::bad_request(
            "Agent 环境变量总大小超过 256 KiB",
        ));
    }
    Ok(project_agent_environment(request.agent_id, environment))
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    #[test]
    fn copied_diagnostics_include_only_declared_checks_and_path() {
        let agent_id = AgentId::parse("codex").unwrap();
        let sections = vec![section(
            "runtime",
            "agents.environmentDiagnosticRuntime",
            vec![check(
                "shell",
                "agents.environmentDiagnosticShell",
                "/bin/zsh".to_string(),
                AgentEnvironmentDiagnosticLevel::Info,
                None,
            )],
        )];
        let report = render_plain_text(
            &agent_id,
            "ok",
            &sections,
            "2026-08-05T00:00:00Z",
            &[PathBuf::from("/usr/bin")],
        );
        assert!(report.contains("agent: codex"));
        assert!(report.contains("shell [Info]: /bin/zsh"));
        assert!(report.contains("/usr/bin"));
        assert!(!report.contains("API_KEY"));
    }

    #[test]
    fn dependency_requirement_uses_minimum_version() {
        assert!(dependency_version_ok(">=18.0.0", "v20.11.0"));
        assert!(!dependency_version_ok(">=20.0.0", "v18.0.0"));
    }

    #[test]
    fn empty_environment_projects_entries_array_not_raw_object() {
        let view = project_agent_environment(AgentId::parse("codex").unwrap(), &HashMap::new());
        let value = serde_json::to_value(&view).expect("serialize");
        assert!(value.get("entries").and_then(Value::as_array).is_some());
        assert_eq!(view.entries.len(), 0);
        assert!(!view.revision.is_empty());
    }

    #[test]
    fn secret_environment_values_are_masked() {
        let mut environment = HashMap::new();
        environment.insert("MODEL".to_string(), "gpt-5".to_string());
        environment.insert("OPENAI_API_KEY".to_string(), "sk-secret".to_string());
        let view = project_agent_environment(AgentId::parse("codex").unwrap(), &environment);
        let model = view
            .entries
            .iter()
            .find(|entry| entry.name == "MODEL")
            .expect("model");
        let secret = view
            .entries
            .iter()
            .find(|entry| entry.name == "OPENAI_API_KEY")
            .expect("secret");
        assert_eq!(model.value.as_deref(), Some("gpt-5"));
        assert!(!model.secret);
        assert_eq!(secret.value, None);
        assert!(secret.secret);
        assert_eq!(secret.masked_value.as_deref(), Some("••••••••"));
    }

    fn replacement_mutation(
        path: &Path,
        expected: &[u8],
        replacement: &[u8],
    ) -> NativeFileMutation {
        NativeFileMutation {
            path: path.to_path_buf(),
            expected: Some(expected.to_vec()),
            replacement: Some(replacement.to_vec()),
            sensitive: false,
        }
    }

    #[tokio::test]
    async fn a_failed_launch_takes_the_configuration_transition_back() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.toml");
        let original = b"default_model = \"dimo\"\n".to_vec();
        tokio::fs::write(&path, &original).await.unwrap();

        let error = apply_config_transition_then(
            vec![replacement_mutation(
                &path,
                &original,
                b"default_model = \"kimi\"\n",
            )],
            || async {
                Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "no terminal emulator",
                ))
            },
        )
        .await
        .unwrap_err();

        assert!(error.envelope().message.contains("no terminal emulator"));
        assert_eq!(tokio::fs::read(&path).await.unwrap(), original);
    }

    #[tokio::test]
    async fn a_failed_launch_recreates_a_credential_the_transition_removed() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("kimi-code.json");
        let original = br#"{"access_token":"dimo-local-gate"}"#.to_vec();
        tokio::fs::write(&path, &original).await.unwrap();

        apply_config_transition_then(
            vec![NativeFileMutation {
                path: path.clone(),
                expected: Some(original.clone()),
                replacement: None,
                sensitive: true,
            }],
            || async { Err(std::io::Error::other("no terminal emulator")) },
        )
        .await
        .unwrap_err();

        assert_eq!(tokio::fs::read(&path).await.unwrap(), original);
    }

    #[tokio::test]
    async fn a_failed_launch_cancels_the_registered_account_flow() {
        let temp = tempfile::tempdir().unwrap();
        let kimi_home = temp.path().join("kimi");
        tokio::fs::create_dir_all(&kimi_home).await.unwrap();
        tokio::fs::write(kimi_home.join("config.toml"), "= not toml =")
            .await
            .unwrap();
        let agent_id = AgentId::parse("kimi_code").unwrap();
        let environment = HashMap::from([(
            "KIMI_CODE_HOME".to_string(),
            kimi_home.display().to_string(),
        )]);
        let result_path = temp.path().join("flow.exit");
        account_flow::register_account_flow(
            &agent_id,
            "login",
            ProfileManagementActionKind::Login,
            result_path.clone(),
        );

        launch_watched_management_action(
            &agent_id,
            "login",
            &environment,
            "kimi acp --login",
            Some(&result_path),
        )
        .await
        .unwrap_err();

        assert!(account_flow::peek_account_flow(&agent_id).is_none());
    }

    #[tokio::test]
    async fn a_transition_that_launches_stays_applied() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("config.toml");
        let original = b"default_model = \"dimo\"\n".to_vec();
        tokio::fs::write(&path, &original).await.unwrap();

        apply_config_transition_then(
            vec![replacement_mutation(&path, &original, b"")],
            || async { Ok(()) },
        )
        .await
        .unwrap();

        assert!(tokio::fs::read(&path).await.unwrap().is_empty());
    }

    #[test]
    fn management_terminal_receives_saved_home_but_never_saved_secrets() {
        let environment = HashMap::from([
            ("CODEX_HOME".to_string(), "/tmp/codex home".to_string()),
            (
                "OPENAI_BASE_URL".to_string(),
                "https://example.test".to_string(),
            ),
            ("OPENAI_API_KEY".to_string(), "sk-secret".to_string()),
        ]);

        let assignments = management_environment_assignments(&environment).join(" ");

        assert!(assignments.contains("CODEX_HOME"));
        assert!(assignments.contains("OPENAI_BASE_URL"));
        assert!(!assignments.contains("OPENAI_API_KEY"));
        assert!(!assignments.contains("sk-secret"));
    }
}
