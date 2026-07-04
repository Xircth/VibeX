use std::{path::PathBuf, time::Duration};

use agents::{
    AgentAvailabilityInfo, AgentDistribution, AgentPreflightCheckStatus, AgentPreflightProbe,
    AgentPreflightReport, AgentRegistryEntry, AgentType, CommandBuildInput, agent_availability,
    agent_type_from_executor_key, build_preflight_report, claude_config_path, codex_auth_path,
    current_platform, opencode_auth_path, registry_entry,
};
use api_types::{
    AgentSettingInfo, PreflightCheck, PreflightFix, PreflightResult, PreflightStatus,
    ReorderAgentsRequest, UpdateAgentPreferences,
};
use db::models::agent_setting::AgentSetting;
use tokio::{net::TcpStream, time::timeout};

use crate::{error::AppError, state::AppState};

fn to_info(row: &AgentSetting) -> AgentSettingInfo {
    AgentSettingInfo {
        id: row.id,
        agent_type: row.agent_type.clone(),
        enabled: row.enabled,
        sort_order: row.sort_order,
        installed_version: row.installed_version.clone(),
        env_json: row.env_json.clone(),
        config_json: row.config_json.clone(),
        auto_approve_mode: row.auto_approve_mode.clone(),
    }
}

#[tauri::command]
pub async fn list_agents(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AgentSettingInfo>, AppError> {
    let pool = &state.deployment.db().pool;
    let rows = AgentSetting::list_all(pool).await?;
    Ok(rows.iter().map(to_info).collect())
}

#[tauri::command]
pub async fn update_agent_preferences(
    state: tauri::State<'_, AppState>,
    payload: UpdateAgentPreferences,
) -> Result<AgentSettingInfo, AppError> {
    validate_agent_config_json(&payload.agent_type, payload.config_json.as_deref())?;
    validate_auto_approve_mode(payload.auto_approve_mode.as_deref())?;

    let pool = &state.deployment.db().pool;
    let updated = AgentSetting::update_preferences(
        pool,
        &payload.agent_type,
        payload.enabled,
        payload.env_json.as_deref(),
        payload.config_json.as_deref(),
        payload.auto_approve_mode.as_deref(),
    )
    .await
    .map_err(|e| match e {
        db::models::agent_setting::AgentSettingError::NotFound => {
            AppError::NotFound(format!("Agent setting not found: {}", payload.agent_type))
        }
        db::models::agent_setting::AgentSettingError::Database(e) => {
            AppError::Internal(e.to_string())
        }
    })?;
    Ok(to_info(&updated))
}

fn validate_auto_approve_mode(mode: Option<&str>) -> Result<(), AppError> {
    match mode {
        None | Some("off" | "allow_always" | "yolo") => Ok(()),
        Some(mode) => Err(AppError::BadRequest(format!(
            "Unsupported auto approve mode: {}",
            mode
        ))),
    }
}

fn validate_agent_config_json(agent_type: &str, config_json: Option<&str>) -> Result<(), AppError> {
    if agent_type != "codex" {
        return Ok(());
    }

    let Some(config_json) = config_json else {
        return Ok(());
    };
    let value: serde_json::Value = serde_json::from_str(config_json)
        .map_err(|e| AppError::BadRequest(format!("Invalid config JSON: {}", e)))?;
    let Some(config) = value.as_object() else {
        return Err(AppError::BadRequest(
            "Codex config JSON must be an object".to_string(),
        ));
    };

    let unsupported = ["model_provider", "supports_websockets", "reasoning_effort"]
        .into_iter()
        .filter(|key| config.contains_key(*key))
        .collect::<Vec<_>>();
    if unsupported.is_empty() {
        Ok(())
    } else {
        Err(AppError::BadRequest(format!(
            "Codex ACP config does not support legacy field(s): {}",
            unsupported.join(", ")
        )))
    }
}

#[tauri::command]
pub async fn reorder_agents(
    state: tauri::State<'_, AppState>,
    payload: ReorderAgentsRequest,
) -> Result<Vec<AgentSettingInfo>, AppError> {
    let pool = &state.deployment.db().pool;
    AgentSetting::reorder(pool, &payload.order).await?;
    let rows = AgentSetting::list_all(pool).await?;
    Ok(rows.iter().map(to_info).collect())
}

fn parse_agent_type_key(agent_type: &str) -> Result<AgentType, AppError> {
    agent_type_from_executor_key(agent_type)
        .ok_or_else(|| AppError::BadRequest(format!("Unknown agent type: {agent_type}")))
}

fn entry_for_agent_key(agent_type: &str) -> Result<AgentRegistryEntry, AppError> {
    Ok(registry_entry(parse_agent_type_key(agent_type)?))
}

fn command_parts_for_entry(entry: &AgentRegistryEntry) -> Result<agents::CommandParts, String> {
    entry
        .distribution
        .command_parts(&CommandBuildInput {
            platform: current_platform(),
            binary_dir: None,
            prefer_system_uvx_command: false,
        })
        .map_err(|error| error.to_string())
}

fn install_source_label(entry: &AgentRegistryEntry) -> String {
    match &entry.distribution {
        AgentDistribution::Npx { package, .. } => format!("npm -g ({package})"),
        AgentDistribution::Binary { .. } => format!("{} release download", entry.name),
        AgentDistribution::Uvx { package, .. } => format!("uvx ({package})"),
        AgentDistribution::System { cmd, .. } => format!("system command ({cmd})"),
    }
}

fn npm_package_for_entry(entry: &AgentRegistryEntry) -> Option<String> {
    match &entry.distribution {
        AgentDistribution::Npx { package, .. } => Some(package.clone()),
        _ => None,
    }
}

fn npm_uninstall_name(package: &str) -> String {
    if let Some(stripped) = package.strip_prefix('@')
        && let Some(index) = stripped.rfind('@')
    {
        return format!("@{}", &stripped[..index]);
    }

    package
        .split_once('@')
        .map(|(name, _)| name.to_string())
        .unwrap_or_else(|| package.to_string())
}

fn install_command_for_agent(agent_type: &str) -> Option<(String, Vec<String>)> {
    let entry = entry_for_agent_key(agent_type).ok()?;
    let package = npm_package_for_entry(&entry)?;
    Some((
        node_installer_program().to_string(),
        vec!["install".to_string(), "-g".to_string(), package],
    ))
}

fn uninstall_command_for_agent(agent_type: &str) -> Option<(String, Vec<String>)> {
    let entry = entry_for_agent_key(agent_type).ok()?;
    let package = npm_package_for_entry(&entry)?;
    Some((
        node_installer_program().to_string(),
        vec![
            "uninstall".to_string(),
            "-g".to_string(),
            npm_uninstall_name(&package),
        ],
    ))
}

#[cfg(windows)]
fn node_installer_program() -> &'static str {
    "npm.cmd"
}

#[cfg(not(windows))]
fn node_installer_program() -> &'static str {
    "npm"
}

async fn resolve_program_on_path(program: &str) -> Result<PathBuf, AppError> {
    let program = program.to_string();
    let lookup = program.clone();
    tokio::task::spawn_blocking(move || which::which(&lookup))
        .await
        .map_err(|e| AppError::Internal(format!("Failed to resolve {}: {}", program, e)))?
        .map_err(|e| AppError::Internal(format!("{} not found in PATH: {}", program, e)))
}

async fn detect_agent_version_inner(
    entry: &AgentRegistryEntry,
    executable: &PathBuf,
) -> Result<Option<String>, AppError> {
    let arg_strings = version_args_for_entry(entry);
    let mut command = utils::process::new_hidden_tokio_command(executable, &arg_strings);
    // Some ACP adapters (notably the npx Claude adapter) do not exit on an
    // unknown `--version` flag and instead wait on stdin, which would hang
    // preflight forever. Bound the probe and kill the child if it overruns.
    command.kill_on_drop(true);
    let output = match timeout(Duration::from_secs(15), command.output()).await {
        Ok(result) => result.map_err(|e| {
            AppError::Internal(format!(
                "Failed to run ACP version command for {:?}: {}",
                entry.agent_type, e
            ))
        })?,
        // Probe timed out: fall back to npm package metadata instead of blocking.
        Err(_) => return detect_global_npm_package_version(entry).await,
    };

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !stdout.is_empty() {
            return Ok(Some(stdout));
        }
    }

    if let Some(version) = detect_global_npm_package_version(entry).await? {
        return Ok(Some(version));
    }

    Ok(None)
}

fn version_args_for_entry(entry: &AgentRegistryEntry) -> Vec<String> {
    match &entry.distribution {
        AgentDistribution::Npx { package, cmd, .. } => {
            let mut args = vec!["-y".to_string(), package.clone()];
            if !cmd.trim().is_empty() {
                args.push(cmd.clone());
            }
            args.push("--version".to_string());
            args
        }
        AgentDistribution::Uvx { package, cmd, .. } => vec![
            "--from".to_string(),
            package.clone(),
            cmd.clone(),
            "--version".to_string(),
        ],
        AgentDistribution::Binary { .. } | AgentDistribution::System { .. } => {
            vec!["--version".to_string()]
        }
    }
}

async fn detect_global_npm_package_version(
    entry: &AgentRegistryEntry,
) -> Result<Option<String>, AppError> {
    let Some(package_name) = npm_package_for_entry(entry) else {
        return Ok(None);
    };

    let npm = resolve_program_on_path(node_installer_program()).await?;
    let mut command = utils::process::new_hidden_tokio_command(&npm, ["root", "-g"]);
    let output = command.output().await.map_err(|e| {
        AppError::Internal(format!(
            "Failed to locate npm global root for {:?}: {e}",
            entry.agent_type
        ))
    })?;

    if !output.status.success() {
        return Ok(None);
    }

    let root = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if root.is_empty() {
        return Ok(None);
    }

    let package_name = npm_uninstall_name(&package_name);
    let package_path = package_name
        .split('/')
        .fold(PathBuf::from(root), |path, segment| path.join(segment))
        .join("package.json");
    let content = match tokio::fs::read_to_string(&package_path).await {
        Ok(content) => content,
        Err(_) => return Ok(None),
    };
    let value: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| AppError::Internal(format!("Invalid package metadata: {e}")))?;

    Ok(value
        .get("version")
        .and_then(|value| value.as_str())
        .map(|version| version.to_string()))
}

fn auth_probe(agent_type: AgentType) -> (bool, Option<String>) {
    let auth_path = match agent_type {
        AgentType::ClaudeCode => claude_config_path(),
        AgentType::Codex => codex_auth_path(),
        AgentType::Opencode => opencode_auth_path(),
        AgentType::Gemini
        | AgentType::Openclaw
        | AgentType::Cline
        | AgentType::Hermes
        | AgentType::QaMock => None,
    };

    if let Some(path) = auth_path {
        let found = path.exists();
        return (
            found,
            Some(if found {
                format!("Authentication marker found at {}.", path.display())
            } else {
                format!("Authentication marker was not found at {}.", path.display())
            }),
        );
    }

    let availability = agent_availability(agent_type);
    match availability {
        AgentAvailabilityInfo::LoginDetected {
            last_auth_timestamp,
        } => (
            true,
            Some(format!(
                "Authentication marker detected at Unix timestamp {last_auth_timestamp}."
            )),
        ),
        AgentAvailabilityInfo::InstallationFound => (
            false,
            Some("Installation was found, but authentication was not detected.".to_string()),
        ),
        AgentAvailabilityInfo::NotFound => (
            false,
            Some("No authentication marker is known for this agent.".to_string()),
        ),
    }
}

async fn network_probe(distribution: &AgentDistribution) -> Option<bool> {
    let endpoint = match distribution {
        AgentDistribution::Npx { .. } => "registry.npmjs.org:443",
        AgentDistribution::Binary { .. } => "github.com:443",
        AgentDistribution::Uvx { .. } => "pypi.org:443",
        AgentDistribution::System { .. } => return None,
    };

    Some(matches!(
        timeout(Duration::from_secs(2), TcpStream::connect(endpoint)).await,
        Ok(Ok(_))
    ))
}

fn preflight_report_to_api(report: AgentPreflightReport) -> PreflightResult {
    PreflightResult {
        checks: report
            .checks
            .into_iter()
            .map(|check| PreflightCheck {
                check_id: check.check_id,
                label: check.label,
                status: preflight_status_to_api(check.status),
                message: check.message,
                fixes: check
                    .fixes
                    .into_iter()
                    .map(|fix| PreflightFix {
                        action: fix.action_key(),
                        label: fix.label().to_string(),
                    })
                    .collect(),
            })
            .collect(),
    }
}

fn preflight_status_to_api(status: AgentPreflightCheckStatus) -> PreflightStatus {
    match status {
        AgentPreflightCheckStatus::Pass => PreflightStatus::Pass,
        AgentPreflightCheckStatus::Warn => PreflightStatus::Warn,
        AgentPreflightCheckStatus::Fail => PreflightStatus::Fail,
    }
}

#[tauri::command]
pub async fn agent_preflight(
    state: tauri::State<'_, AppState>,
    agent_type: String,
) -> Result<PreflightResult, AppError> {
    let entry = entry_for_agent_key(&agent_type)?;
    let command_parts = command_parts_for_entry(&entry);
    let (runtime_program, runtime_path, runtime_lookup_error) = match command_parts {
        Ok(parts) => {
            let program = parts.program;
            match resolve_program_on_path(&program).await {
                Ok(path) => (Some(program), Some(path), None),
                Err(error) => (Some(program), None, Some(error.to_string())),
            }
        }
        Err(error) => (None, None, Some(error)),
    };

    let (adapter_version, adapter_version_error) = match runtime_path.as_ref() {
        Some(executable) => match detect_agent_version_inner(&entry, executable).await {
            Ok(Some(version)) if !version.trim().is_empty() => {
                let pool = &state.deployment.db().pool;
                let _ =
                    AgentSetting::update_version(pool, &agent_type, Some(version.as_str())).await;
                (Some(version), None)
            }
            Ok(_) => (None, None),
            Err(error) => (None, Some(error.to_string())),
        },
        None => {
            let pool = &state.deployment.db().pool;
            let _ = AgentSetting::update_version(pool, &agent_type, None).await;
            (None, None)
        }
    };
    let (auth_found, auth_hint) = auth_probe(entry.agent_type);
    let network_available = network_probe(&entry.distribution).await;
    let source = install_source_label(&entry);
    let report = build_preflight_report(AgentPreflightProbe {
        entry,
        platform: current_platform(),
        runtime_program,
        runtime_path: runtime_path.map(|path| path.display().to_string()),
        runtime_lookup_error,
        adapter_version: adapter_version.map(|version| format!("{version} - Source: {source}")),
        adapter_version_error,
        auth_found,
        auth_hint,
        network_available,
    });

    Ok(preflight_report_to_api(report))
}

#[tauri::command]
pub async fn detect_agent_local_version(
    state: tauri::State<'_, AppState>,
    agent_type: String,
) -> Result<Option<String>, AppError> {
    let entry = entry_for_agent_key(&agent_type)?;
    let program = match command_parts_for_entry(&entry) {
        Ok(parts) => parts.program,
        Err(_) => return Ok(None),
    };

    let executable = match resolve_program_on_path(&program).await {
        Ok(path) => path,
        Err(_) => {
            let pool = &state.deployment.db().pool;
            let _ = AgentSetting::update_version(pool, &agent_type, None).await;
            return Ok(None);
        }
    };

    let version = detect_agent_version_inner(&entry, &executable).await?;
    let pool = &state.deployment.db().pool;
    let _ = AgentSetting::update_version(pool, &agent_type, version.as_deref()).await;
    Ok(version)
}

#[tauri::command]
pub async fn run_agent_fix(
    state: tauri::State<'_, AppState>,
    agent_type: String,
    action: String,
) -> Result<(), AppError> {
    match action.as_str() {
        "install_npm" | "upgrade_npm" => {
            let (program, args) = install_command_for_agent(&agent_type).ok_or_else(|| {
                AppError::Internal(format!("No install action available for {}", agent_type))
            })?;

            let executable = resolve_program_on_path(&program).await?;
            let mut command = utils::process::new_hidden_tokio_command(&executable, &args);
            let output = command.output().await.map_err(|e| {
                AppError::Internal(format!(
                    "Failed to run install command for {}: {}",
                    agent_type, e
                ))
            })?;

            if !output.status.success() {
                return Err(AppError::Internal(
                    utils::process::command_output_detail(&output)
                        .map(|detail| {
                            format!("Install command failed for {}: {}", agent_type, detail)
                        })
                        .unwrap_or_else(|| format!("Install command failed for {}", agent_type)),
                ));
            }
        }
        "uninstall_npm" => {
            let (program, args) = uninstall_command_for_agent(&agent_type).ok_or_else(|| {
                AppError::Internal(format!("No uninstall action available for {}", agent_type))
            })?;

            let executable = resolve_program_on_path(&program).await?;
            let mut command = utils::process::new_hidden_tokio_command(&executable, &args);
            let output = command.output().await.map_err(|e| {
                AppError::Internal(format!(
                    "Failed to run uninstall command for {}: {}",
                    agent_type, e
                ))
            })?;

            if !output.status.success() {
                return Err(AppError::Internal(
                    utils::process::command_output_detail(&output)
                        .map(|detail| {
                            format!("Uninstall command failed for {}: {}", agent_type, detail)
                        })
                        .unwrap_or_else(|| format!("Uninstall command failed for {}", agent_type)),
                ));
            }
        }
        _ => {
            return Err(AppError::Internal(format!(
                "Unsupported agent fix action: {}",
                action
            )));
        }
    }

    let _ = detect_agent_local_version(state, agent_type).await?;
    Ok(())
}

/// The interactive login command for an agent's own CLI, if it has one.
fn login_command_for_agent(agent_type: AgentType) -> Option<&'static str> {
    match agent_type {
        AgentType::Codex => Some("codex login"),
        _ => None,
    }
}

/// Open the agent's interactive login command in a visible OS terminal so the
/// user can complete the (browser/device-code) auth flow. The CLI writes its
/// own credentials (e.g. `~/.codex/auth.json`) which VibeX then detects.
#[tauri::command]
pub async fn open_agent_login_terminal(agent_type: String) -> Result<(), AppError> {
    let agent = parse_agent_type_key(&agent_type)?;
    let command = login_command_for_agent(agent).ok_or_else(|| {
        AppError::BadRequest(format!("{agent_type} does not support in-app login"))
    })?;

    let spawn_result = spawn_login_terminal(command);
    spawn_result.map_err(|e| AppError::Internal(format!("Failed to open login terminal: {e}")))
}

#[cfg(target_os = "windows")]
fn spawn_login_terminal(command: &str) -> std::io::Result<()> {
    // Open a new console window that runs the login command and stays open so
    // the device-code / browser prompt remains visible.
    std::process::Command::new("cmd")
        .args(["/C", "start", "", "cmd", "/K", command])
        .spawn()
        .map(|_| ())
}

#[cfg(target_os = "macos")]
fn spawn_login_terminal(command: &str) -> std::io::Result<()> {
    let script = format!(
        "tell application \"Terminal\" to do script \"{}\"",
        command.replace('\\', "\\\\").replace('"', "\\\"")
    );
    std::process::Command::new("osascript")
        .args(["-e", &script])
        .spawn()
        .map(|_| ())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn spawn_login_terminal(command: &str) -> std::io::Result<()> {
    let run = format!("{command}; exec $SHELL");
    for terminal in ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"] {
        if which::which(terminal).is_ok() {
            if let Ok(()) = std::process::Command::new(terminal)
                .args(["-e", "sh", "-lc", &run])
                .spawn()
                .map(|_| ())
            {
                return Ok(());
            }
        }
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "no supported terminal emulator found",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_acp_config_accepts_supported_fields() {
        validate_agent_config_json(
            "codex",
            Some(r#"{"model":"gpt-5.4","model_reasoning_effort":"high"}"#),
        )
        .expect("supported codex config should pass");
    }

    #[test]
    fn codex_acp_config_rejects_legacy_fields() {
        let err = validate_agent_config_json(
            "codex",
            Some(r#"{"model_provider":"openai","supports_websockets":true,"reasoning_effort":"high"}"#),
        )
        .expect_err("legacy codex config should fail");

        assert!(matches!(err, AppError::BadRequest(_)));
        assert!(err.to_string().contains("model_provider"));
        assert!(err.to_string().contains("supports_websockets"));
        assert!(err.to_string().contains("reasoning_effort"));
    }

    #[test]
    fn validates_auto_approve_modes() {
        validate_auto_approve_mode(None).expect("empty auto approve mode is allowed");
        validate_auto_approve_mode(Some("off")).expect("off is allowed");
        validate_auto_approve_mode(Some("allow_always")).expect("allow_always is allowed");
        validate_auto_approve_mode(Some("yolo")).expect("yolo is allowed");

        assert!(matches!(
            validate_auto_approve_mode(Some("always")),
            Err(AppError::BadRequest(_))
        ));
    }

    #[test]
    fn maps_registry_npx_agents_to_npm_package_specs() {
        assert_eq!(
            npm_package_for_entry(&registry_entry(AgentType::ClaudeCode)).as_deref(),
            Some("@agentclientprotocol/claude-agent-acp@0.44.0")
        );
        assert_eq!(
            npm_package_for_entry(&registry_entry(AgentType::Gemini)).as_deref(),
            Some("@google/gemini-cli@0.45.2")
        );
        assert_eq!(
            npm_package_for_entry(&registry_entry(AgentType::Codex)).as_deref(),
            Some("@agentclientprotocol/codex-acp@1.0.2")
        );
        assert_eq!(
            npm_package_for_entry(&registry_entry(AgentType::Opencode)).as_deref(),
            Some("opencode-ai@1.17.11")
        );
        assert_eq!(
            npm_uninstall_name("@google/gemini-cli@0.45.2"),
            "@google/gemini-cli"
        );
    }

    #[test]
    fn registry_preflight_helpers_cover_binary_and_npx_agents() {
        let codex = registry_entry(AgentType::Codex);
        assert!(install_source_label(&codex).contains("npm -g"));
        assert_eq!(
            version_args_for_entry(&codex),
            vec![
                "-y".to_string(),
                "@agentclientprotocol/codex-acp@1.0.2".to_string(),
                "codex-acp".to_string(),
                "--version".to_string()
            ]
        );

        let gemini = registry_entry(AgentType::Gemini);
        assert_eq!(
            version_args_for_entry(&gemini),
            vec![
                "-y".to_string(),
                "@google/gemini-cli@0.45.2".to_string(),
                "gemini".to_string(),
                "--version".to_string()
            ]
        );

        let hermes = registry_entry(AgentType::Hermes);
        assert_eq!(
            version_args_for_entry(&hermes),
            vec![
                "--from".to_string(),
                "hermes-agent[acp,mcp]==0.16.0".to_string(),
                "hermes-acp".to_string(),
                "--version".to_string()
            ]
        );
    }

    #[test]
    fn parses_all_registry_agent_keys_for_settings_commands() {
        assert_eq!(
            parse_agent_type_key("open_claw").unwrap(),
            AgentType::Openclaw
        );
        assert_eq!(parse_agent_type_key("cline").unwrap(), AgentType::Cline);
        assert_eq!(parse_agent_type_key("hermes").unwrap(), AgentType::Hermes);
    }
}
