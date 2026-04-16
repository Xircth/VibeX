use std::path::PathBuf;

use api_types::{
    AgentSettingInfo, PreflightCheck, PreflightFix, PreflightResult, PreflightStatus,
    ReorderAgentsRequest, UpdateAgentPreferences,
};
use db::models::agent_setting::AgentSetting;
use deployment::Deployment;
use tokio::fs;

use crate::{error::AppError, state::AppState};

/// Convert a DB model to API response type.
fn to_info(row: &AgentSetting) -> AgentSettingInfo {
    AgentSettingInfo {
        id: row.id,
        agent_type: row.agent_type.clone(),
        enabled: row.enabled,
        sort_order: row.sort_order,
        installed_version: row.installed_version.clone(),
        env_json: row.env_json.clone(),
        config_json: row.config_json.clone(),
    }
}

/// List all agent settings ordered by sort_order.
#[tauri::command]
pub async fn list_agents(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AgentSettingInfo>, AppError> {
    let pool = &state.deployment.db().pool;
    let rows = AgentSetting::list_all(pool).await?;
    Ok(rows.iter().map(to_info).collect())
}

/// Update an agent's preferences (enabled, env_json, config_json).
#[tauri::command]
pub async fn update_agent_preferences(
    state: tauri::State<'_, AppState>,
    payload: UpdateAgentPreferences,
) -> Result<AgentSettingInfo, AppError> {
    let pool = &state.deployment.db().pool;
    let updated = AgentSetting::update_preferences(
        pool,
        &payload.agent_type,
        payload.enabled,
        payload.env_json.as_deref(),
        payload.config_json.as_deref(),
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

/// Reorder agents by providing an ordered list of agent_type strings.
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

/// Determine the CLI command name for a given agent_type.
fn cli_command_for_agent(agent_type: &str) -> Option<&'static str> {
    match agent_type {
        "claude_code" => Some("claude"),
        "codex" => Some("codex"),
        "open_code" => Some("opencode"),
        _ => None,
    }
}

fn install_source_label(agent_type: &str) -> Option<&'static str> {
    match agent_type {
        "claude_code" => Some("npm -g (@anthropic-ai/claude-code)"),
        "codex" => Some("npm -g (@openai/codex)"),
        "open_code" => Some("go install (github.com/opencode-ai/opencode@latest)"),
        _ => None,
    }
}

fn install_command_for_agent(agent_type: &str) -> Option<(&'static str, Vec<&'static str>)> {
    match agent_type {
        "claude_code" => Some((
            installer_program_for_node(),
            vec!["install", "-g", "@anthropic-ai/claude-code"],
        )),
        "codex" => Some((
            installer_program_for_node(),
            vec!["install", "-g", "@openai/codex"],
        )),
        "open_code" => Some((
            installer_program_for_go(),
            vec!["install", "github.com/opencode-ai/opencode@latest"],
        )),
        _ => None,
    }
}

fn uninstall_command_for_agent(agent_type: &str) -> Option<(&'static str, Vec<&'static str>)> {
    match agent_type {
        "claude_code" => Some((
            installer_program_for_node(),
            vec!["uninstall", "-g", "@anthropic-ai/claude-code"],
        )),
        "codex" => Some((
            installer_program_for_node(),
            vec!["uninstall", "-g", "@openai/codex"],
        )),
        _ => None,
    }
}

#[cfg(windows)]
fn installer_program_for_node() -> &'static str {
    "npm.cmd"
}

#[cfg(not(windows))]
fn installer_program_for_node() -> &'static str {
    "npm"
}

#[cfg(windows)]
fn installer_program_for_go() -> &'static str {
    "go.exe"
}

#[cfg(not(windows))]
fn installer_program_for_go() -> &'static str {
    "go"
}

async fn resolve_program_on_path(program: &str) -> Result<PathBuf, AppError> {
    let program = program.to_string();
    let lookup = program.clone();
    tokio::task::spawn_blocking(move || which::which(&lookup))
        .await
        .map_err(|e| AppError::Internal(format!("Failed to resolve {}: {}", program, e)))?
        .map_err(|e| AppError::Internal(format!("{} not found in PATH: {}", program, e)))
}

/// Run preflight checks for an agent (check CLI availability, version, etc.).
#[tauri::command]
pub async fn agent_preflight(
    state: tauri::State<'_, AppState>,
    agent_type: String,
) -> Result<PreflightResult, AppError> {
    let _ = &state;
    let mut checks = Vec::new();

    let cli_cmd = match cli_command_for_agent(&agent_type) {
        Some(cmd) => cmd,
        None => {
            checks.push(PreflightCheck {
                check_id: "unknown_agent".to_string(),
                label: "Agent Type".to_string(),
                status: PreflightStatus::Fail,
                message: format!("Unknown agent type: {}", agent_type),
                fixes: vec![],
            });
            return Ok(PreflightResult { checks });
        }
    };

    // Check 1: CLI installed
    let which_result = tokio::task::spawn_blocking({
        let cmd = cli_cmd.to_string();
        move || which::which(cmd)
    })
    .await
    .ok()
    .and_then(|r| r.ok());

    let executable = match which_result {
        Some(path) => {
            checks.push(PreflightCheck {
                check_id: "cli_installed".to_string(),
                label: format!("{} CLI", cli_cmd),
                status: PreflightStatus::Pass,
                message: format!("Found at {}", path.display()),
                fixes: vec![],
            });
            path
        }
        None => {
            let install_hint =
                install_source_label(&agent_type).unwrap_or("See agent documentation");
            let install_action = match agent_type.as_str() {
                "claude_code" | "codex" => "install_npm",
                "open_code" => "install_go",
                _ => "install",
            };
            checks.push(PreflightCheck {
                check_id: "cli_installed".to_string(),
                label: format!("{} CLI", cli_cmd),
                status: PreflightStatus::Fail,
                message: format!("`{}` not found in PATH. Source: {}", cli_cmd, install_hint),
                fixes: vec![PreflightFix {
                    action: install_action.to_string(),
                    label: format!("Install ({})", install_hint),
                }],
            });
            return Ok(PreflightResult { checks });
        }
    };

    // Check 2: version detection
    let mut ver_cmd =
        utils::process::new_hidden_tokio_command(&executable, &["--version".to_string()]);
    let version_output = ver_cmd.output().await;

    match version_output {
        Ok(output) if output.status.success() => {
            let version_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let source = install_source_label(&agent_type).unwrap_or("manual");
            // Try to update the stored version in DB
            let pool = &state.deployment.db().pool;
            let _ = AgentSetting::update_version(pool, &agent_type, Some(&version_str)).await;

            checks.push(PreflightCheck {
                check_id: "cli_version".to_string(),
                label: "Version".to_string(),
                status: PreflightStatus::Pass,
                message: format!("{} · Source: {}", version_str, source),
                fixes: vec![
                    PreflightFix {
                        action: match agent_type.as_str() {
                            "claude_code" | "codex" => "upgrade_npm".to_string(),
                            "open_code" => "upgrade_go".to_string(),
                            _ => "upgrade".to_string(),
                        },
                        label: format!("Upgrade ({})", source),
                    },
                    PreflightFix {
                        action: match agent_type.as_str() {
                            "claude_code" | "codex" => "uninstall_npm".to_string(),
                            "open_code" => "uninstall_binary".to_string(),
                            _ => "uninstall".to_string(),
                        },
                        label: format!("Uninstall ({})", source),
                    },
                ],
            });
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let source = install_source_label(&agent_type).unwrap_or("manual");
            checks.push(PreflightCheck {
                check_id: "cli_version".to_string(),
                label: "Version".to_string(),
                status: PreflightStatus::Warn,
                message: format!(
                    "Could not determine version: {}. Source: {}",
                    stderr, source
                ),
                fixes: vec![
                    PreflightFix {
                        action: match agent_type.as_str() {
                            "claude_code" | "codex" => "upgrade_npm".to_string(),
                            "open_code" => "upgrade_go".to_string(),
                            _ => "upgrade".to_string(),
                        },
                        label: format!("Upgrade ({})", source),
                    },
                    PreflightFix {
                        action: match agent_type.as_str() {
                            "claude_code" | "codex" => "uninstall_npm".to_string(),
                            "open_code" => "uninstall_binary".to_string(),
                            _ => "uninstall".to_string(),
                        },
                        label: format!("Uninstall ({})", source),
                    },
                ],
            });
        }
        Err(e) => {
            let source = install_source_label(&agent_type).unwrap_or("manual");
            checks.push(PreflightCheck {
                check_id: "cli_version".to_string(),
                label: "Version".to_string(),
                status: PreflightStatus::Warn,
                message: format!("Failed to run --version: {}. Source: {}", e, source),
                fixes: vec![
                    PreflightFix {
                        action: match agent_type.as_str() {
                            "claude_code" | "codex" => "upgrade_npm".to_string(),
                            "open_code" => "upgrade_go".to_string(),
                            _ => "upgrade".to_string(),
                        },
                        label: format!("Upgrade ({})", source),
                    },
                    PreflightFix {
                        action: match agent_type.as_str() {
                            "claude_code" | "codex" => "uninstall_npm".to_string(),
                            "open_code" => "uninstall_binary".to_string(),
                            _ => "uninstall".to_string(),
                        },
                        label: format!("Uninstall ({})", source),
                    },
                ],
            });
        }
    }

    Ok(PreflightResult { checks })
}

/// Detect the locally installed version of an agent CLI.
#[tauri::command]
pub async fn detect_agent_local_version(
    state: tauri::State<'_, AppState>,
    agent_type: String,
) -> Result<Option<String>, AppError> {
    let cli_cmd = match cli_command_for_agent(&agent_type) {
        Some(cmd) => cmd,
        None => return Ok(None),
    };

    // Check if CLI exists
    let which_result = tokio::task::spawn_blocking({
        let cmd = cli_cmd.to_string();
        move || which::which(cmd)
    })
    .await
    .ok()
    .and_then(|r| r.ok());

    let executable = match which_result {
        Some(path) => path,
        None => {
            // Update DB to clear version
            let pool = &state.deployment.db().pool;
            let _ = AgentSetting::update_version(pool, &agent_type, None).await;
            return Ok(None);
        }
    };

    let mut ver_cmd =
        utils::process::new_hidden_tokio_command(&executable, &["--version".to_string()]);
    let output = ver_cmd
        .output()
        .await
        .map_err(|e| AppError::Internal(format!("Failed to run {} --version: {}", cli_cmd, e)))?;

    if output.status.success() {
        let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
        // Update DB with detected version
        let pool = &state.deployment.db().pool;
        let _ = AgentSetting::update_version(pool, &agent_type, Some(&version)).await;
        Ok(Some(version))
    } else {
        Ok(None)
    }
}

/// Run a supported fix action for an agent preflight check.
#[tauri::command]
pub async fn run_agent_fix(
    state: tauri::State<'_, AppState>,
    agent_type: String,
    action: String,
) -> Result<(), AppError> {
    match action.as_str() {
        "install_npm" | "upgrade_npm" | "install_go" | "upgrade_go" => {
            let (program, args) = install_command_for_agent(&agent_type).ok_or_else(|| {
                AppError::Internal(format!("No install action available for {}", agent_type))
            })?;

            let executable = resolve_program_on_path(program).await?;
            let arg_strings = args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();
            let mut command = utils::process::new_hidden_tokio_command(&executable, &arg_strings);
            let output = command.output().await.map_err(|e| {
                AppError::Internal(format!(
                    "Failed to run install command for {}: {}",
                    agent_type, e
                ))
            })?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let detail = if !stderr.is_empty() { stderr } else { stdout };
                return Err(AppError::Internal(if detail.is_empty() {
                    format!("Install command failed for {}", agent_type)
                } else {
                    format!("Install command failed for {}: {}", agent_type, detail)
                }));
            }
        }
        "uninstall_npm" => {
            let (program, args) = uninstall_command_for_agent(&agent_type).ok_or_else(|| {
                AppError::Internal(format!("No uninstall action available for {}", agent_type))
            })?;

            let executable = resolve_program_on_path(program).await?;
            let arg_strings = args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();
            let mut command = utils::process::new_hidden_tokio_command(&executable, &arg_strings);
            let output = command.output().await.map_err(|e| {
                AppError::Internal(format!(
                    "Failed to run uninstall command for {}: {}",
                    agent_type, e
                ))
            })?;

            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let detail = if !stderr.is_empty() { stderr } else { stdout };
                return Err(AppError::Internal(if detail.is_empty() {
                    format!("Uninstall command failed for {}", agent_type)
                } else {
                    format!("Uninstall command failed for {}: {}", agent_type, detail)
                }));
            }
        }
        "uninstall_binary" => {
            let cli_cmd = cli_command_for_agent(&agent_type)
                .ok_or_else(|| AppError::Internal(format!("Unknown agent type: {}", agent_type)))?;
            let executable = resolve_program_on_path(cli_cmd).await?;
            fs::remove_file(&executable).await.map_err(|e| {
                AppError::Internal(format!(
                    "Failed to remove executable {}: {}",
                    executable.display(),
                    e
                ))
            })?;
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
