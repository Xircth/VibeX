use std::path::PathBuf;

use api_types::{
    AgentSettingInfo, PreflightCheck, PreflightFix, PreflightResult, PreflightStatus,
    ReorderAgentsRequest, UpdateAgentPreferences,
};
use db::models::agent_setting::AgentSetting;
use deployment::Deployment;

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

fn runtime_launcher_for_agent(agent_type: &str) -> Option<&'static str> {
    match agent_type {
        "claude_code" | "codex" => Some(node_runner_program()),
        "open_code" => Some("opencode"),
        _ => None,
    }
}

fn install_source_label(agent_type: &str) -> Option<&'static str> {
    match agent_type {
        "claude_code" => Some("npm -g (@agentclientprotocol/claude-agent-acp)"),
        "codex" => Some("npm -g (@zed-industries/codex-acp)"),
        "open_code" => Some("npm -g (opencode-ai)"),
        _ => None,
    }
}

fn install_command_for_agent(agent_type: &str) -> Option<(&'static str, Vec<&'static str>)> {
    match agent_type {
        "claude_code" => Some((
            node_installer_program(),
            vec!["install", "-g", "@agentclientprotocol/claude-agent-acp"],
        )),
        "codex" => Some((
            node_installer_program(),
            vec!["install", "-g", "@zed-industries/codex-acp"],
        )),
        "open_code" => Some((
            node_installer_program(),
            vec!["install", "-g", "opencode-ai"],
        )),
        _ => None,
    }
}

fn uninstall_command_for_agent(agent_type: &str) -> Option<(&'static str, Vec<&'static str>)> {
    match agent_type {
        "claude_code" => Some((
            node_installer_program(),
            vec!["uninstall", "-g", "@agentclientprotocol/claude-agent-acp"],
        )),
        "codex" => Some((
            node_installer_program(),
            vec!["uninstall", "-g", "@zed-industries/codex-acp"],
        )),
        "open_code" => Some((
            node_installer_program(),
            vec!["uninstall", "-g", "opencode-ai"],
        )),
        _ => None,
    }
}

fn version_command_for_agent(agent_type: &str) -> Option<(&'static str, Vec<&'static str>)> {
    match agent_type {
        "claude_code" => Some((
            node_runner_program(),
            vec!["-y", "@agentclientprotocol/claude-agent-acp", "--version"],
        )),
        "codex" => Some((
            node_runner_program(),
            vec!["-y", "@zed-industries/codex-acp", "--version"],
        )),
        "open_code" => Some(("opencode", vec!["--version"])),
        _ => None,
    }
}

#[cfg(windows)]
fn node_installer_program() -> &'static str {
    "npm.cmd"
}

#[cfg(not(windows))]
fn node_installer_program() -> &'static str {
    "npm"
}

#[cfg(windows)]
fn node_runner_program() -> &'static str {
    "npx.cmd"
}

#[cfg(not(windows))]
fn node_runner_program() -> &'static str {
    "npx"
}

async fn resolve_program_on_path(program: &str) -> Result<PathBuf, AppError> {
    let program = program.to_string();
    let lookup = program.clone();
    tokio::task::spawn_blocking(move || which::which(&lookup))
        .await
        .map_err(|e| AppError::Internal(format!("Failed to resolve {}: {}", program, e)))?
        .map_err(|e| AppError::Internal(format!("{} not found in PATH: {}", program, e)))
}

fn fix_actions(agent_type: &str, source: &str) -> Vec<PreflightFix> {
    match agent_type {
        "claude_code" | "codex" | "open_code" => vec![
            PreflightFix {
                action: "upgrade_npm".to_string(),
                label: format!("Update ({})", source),
            },
            PreflightFix {
                action: "uninstall_npm".to_string(),
                label: format!("Uninstall ({})", source),
            },
        ],
        _ => vec![],
    }
}

async fn detect_agent_version_inner(
    agent_type: &str,
    executable: &PathBuf,
) -> Result<Option<String>, AppError> {
    let (_, args) = version_command_for_agent(agent_type)
        .ok_or_else(|| AppError::Internal(format!("No ACP version command for {}", agent_type)))?;
    let arg_strings = args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();
    let mut command = utils::process::new_hidden_tokio_command(executable, &arg_strings);
    let output = command.output().await.map_err(|e| {
        AppError::Internal(format!(
            "Failed to run ACP version command for {}: {}",
            agent_type, e
        ))
    })?;

    if output.status.success() {
        Ok(Some(
            String::from_utf8_lossy(&output.stdout).trim().to_string(),
        ))
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub async fn agent_preflight(
    state: tauri::State<'_, AppState>,
    agent_type: String,
) -> Result<PreflightResult, AppError> {
    let mut checks = Vec::new();
    let launcher = match runtime_launcher_for_agent(&agent_type) {
        Some(cmd) => cmd,
        None => {
            checks.push(PreflightCheck {
                check_id: "unknown_agent".to_string(),
                label: "Agent type".to_string(),
                status: PreflightStatus::Fail,
                message: format!("Unknown agent type: {}", agent_type),
                fixes: vec![],
            });
            return Ok(PreflightResult { checks });
        }
    };

    let which_result = tokio::task::spawn_blocking({
        let cmd = launcher.to_string();
        move || which::which(cmd)
    })
    .await
    .ok()
    .and_then(|r| r.ok());

    let executable = match which_result {
        Some(path) => {
            checks.push(PreflightCheck {
                check_id: "runtime_launcher".to_string(),
                label: format!("{} runtime launcher", launcher),
                status: PreflightStatus::Pass,
                message: format!("Found at {}", path.display()),
                fixes: vec![],
            });
            path
        }
        None => {
            let source = install_source_label(&agent_type).unwrap_or("manual install");
            checks.push(PreflightCheck {
                check_id: "runtime_launcher".to_string(),
                label: format!("{} runtime launcher", launcher),
                status: PreflightStatus::Fail,
                message: format!(
                    "ACP runtime launcher `{}` was not found in the app PATH. Source: {}",
                    launcher, source
                ),
                fixes: vec![PreflightFix {
                    action: "install_npm".to_string(),
                    label: format!("Install ({})", source),
                }],
            });
            return Ok(PreflightResult { checks });
        }
    };

    let source = install_source_label(&agent_type).unwrap_or("manual install");
    match detect_agent_version_inner(&agent_type, &executable).await {
        Ok(Some(version)) if !version.is_empty() => {
            let pool = &state.deployment.db().pool;
            let _ = AgentSetting::update_version(pool, &agent_type, Some(&version)).await;
            checks.push(PreflightCheck {
                check_id: "adapter_version".to_string(),
                label: "ACP adapter version".to_string(),
                status: PreflightStatus::Pass,
                message: format!("{} - Source: {}", version, source),
                fixes: fix_actions(&agent_type, source),
            });
        }
        Ok(_) => {
            checks.push(PreflightCheck {
                check_id: "adapter_version".to_string(),
                label: "ACP adapter version".to_string(),
                status: PreflightStatus::Warn,
                message: format!("Could not determine adapter version. Source: {}", source),
                fixes: fix_actions(&agent_type, source),
            });
        }
        Err(e) => {
            checks.push(PreflightCheck {
                check_id: "adapter_version".to_string(),
                label: "ACP adapter version".to_string(),
                status: PreflightStatus::Warn,
                message: format!(
                    "Failed to run adapter version command: {}. Source: {}",
                    e, source
                ),
                fixes: fix_actions(&agent_type, source),
            });
        }
    }

    Ok(PreflightResult { checks })
}

#[tauri::command]
pub async fn detect_agent_local_version(
    state: tauri::State<'_, AppState>,
    agent_type: String,
) -> Result<Option<String>, AppError> {
    let launcher = match runtime_launcher_for_agent(&agent_type) {
        Some(cmd) => cmd,
        None => return Ok(None),
    };

    let which_result = tokio::task::spawn_blocking({
        let cmd = launcher.to_string();
        move || which::which(cmd)
    })
    .await
    .ok()
    .and_then(|r| r.ok());

    let executable = match which_result {
        Some(path) => path,
        None => {
            let pool = &state.deployment.db().pool;
            let _ = AgentSetting::update_version(pool, &agent_type, None).await;
            return Ok(None);
        }
    };

    let version = detect_agent_version_inner(&agent_type, &executable).await?;
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
}
