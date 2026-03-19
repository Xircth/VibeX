use api_types::{
    AgentSettingInfo, PreflightCheck, PreflightFix, PreflightResult, PreflightStatus,
    ReorderAgentsRequest, UpdateAgentPreferences,
};
use db::models::agent_setting::AgentSetting;
use deployment::Deployment;

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
            let install_hint = match agent_type.as_str() {
                "claude_code" => "npm install -g @anthropic-ai/claude-code",
                "codex" => "npm install -g @openai/codex",
                "open_code" => "go install github.com/opencode-ai/opencode@latest",
                _ => "See agent documentation",
            };
            checks.push(PreflightCheck {
                check_id: "cli_installed".to_string(),
                label: format!("{} CLI", cli_cmd),
                status: PreflightStatus::Fail,
                message: format!("`{}` not found in PATH", cli_cmd),
                fixes: vec![PreflightFix {
                    action: "install".to_string(),
                    label: format!("Install: {}", install_hint),
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
            // Try to update the stored version in DB
            let pool = &state.deployment.db().pool;
            let _ = AgentSetting::update_version(pool, &agent_type, Some(&version_str)).await;

            checks.push(PreflightCheck {
                check_id: "cli_version".to_string(),
                label: "Version".to_string(),
                status: PreflightStatus::Pass,
                message: version_str,
                fixes: vec![],
            });
        }
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            checks.push(PreflightCheck {
                check_id: "cli_version".to_string(),
                label: "Version".to_string(),
                status: PreflightStatus::Warn,
                message: format!("Could not determine version: {}", stderr),
                fixes: vec![],
            });
        }
        Err(e) => {
            checks.push(PreflightCheck {
                check_id: "cli_version".to_string(),
                label: "Version".to_string(),
                status: PreflightStatus::Warn,
                message: format!("Failed to run --version: {}", e),
                fixes: vec![],
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
