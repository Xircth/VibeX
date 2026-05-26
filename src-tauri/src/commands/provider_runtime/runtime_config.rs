use std::path::{Path, PathBuf};

use deployment::Deployment;
use executors::{
    executors::{
        CodingAgent,
        codex::{AskForApproval, ReasoningEffort, SandboxMode},
    },
    profile::{ExecutorConfig, ExecutorConfigs, ExecutorProfileId},
};
use serde_json::{Value, json};
use services::services::config::DEFAULT_COMMIT_REMINDER_PROMPT;

use super::{
    ACP_FALLBACK_ENV, CLAUDE_ACP_FALLBACK_ENV, CODEX_ACP_FALLBACK_ENV, OPENCODE_ACP_FALLBACK_ENV,
    ProviderId, ProviderTurnRequest,
};
use crate::{error::AppError, state::AppState};

pub(super) fn should_hide_provider_slash_command(provider: ProviderId, name: &str) -> bool {
    let normalized = name.trim().trim_start_matches('/').to_ascii_lowercase();
    if matches!(normalized.as_str(), "config" | "mcp" | "model" | "theme") {
        return true;
    }
    if provider == ProviderId::Claude && normalized == "permissions" {
        return true;
    }
    provider == ProviderId::Opencode
        && matches!(
            normalized.as_str(),
            "agents" | "build" | "commands" | "models" | "plan" | "session" | "sessions" | "status"
        )
}

fn provider_from_executor_name(executor: &str) -> Option<ProviderId> {
    match executor.trim().to_ascii_uppercase().as_str() {
        "CLAUDE_CODE" | "CLAUDECODE" | "CLAUDE" | "CLAUDE-CODE" | "CLAUDE_CODE_ACP" => {
            Some(ProviderId::Claude)
        }
        "CODEX" | "CODEX_ACP" => Some(ProviderId::Codex),
        "OPENCODE" | "OPEN_CODE" | "OPEN-CODE" | "OPENCODE_ACP" => Some(ProviderId::Opencode),
        _ => None,
    }
}

pub(super) fn session_executor_matches_provider(
    executor: Option<&str>,
    provider: ProviderId,
) -> bool {
    executor
        .and_then(provider_from_executor_name)
        .is_none_or(|session_provider| session_provider == provider)
}

pub(super) fn provider_option_string<'a>(
    options: &'a serde_json::Map<String, Value>,
    key: &str,
) -> Option<&'a str> {
    options
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

pub(super) fn provider_option_bool(options: &serde_json::Map<String, Value>, key: &str) -> bool {
    options.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn provider_option_optional_bool(
    options: &serde_json::Map<String, Value>,
    key: &str,
) -> Option<bool> {
    options.get(key).and_then(Value::as_bool)
}

pub(super) fn provider_executor_profile_id(request: &ProviderTurnRequest) -> ExecutorProfileId {
    request
        .executor_profile_id
        .clone()
        .unwrap_or_else(|| ExecutorProfileId::new(request.provider.base_agent()))
}

pub(super) fn validate_provider_executor_profile(
    request: &ProviderTurnRequest,
) -> Result<(), AppError> {
    if let Some(profile_id) = &request.executor_profile_id
        && profile_id.executor != request.provider.base_agent()
    {
        return Err(AppError::BadRequest(format!(
            "Provider {:?} cannot run executor profile {}",
            request.provider, profile_id
        )));
    }
    Ok(())
}

pub(super) fn provider_executor_config(request: &ProviderTurnRequest) -> ExecutorConfig {
    ExecutorConfig::from(provider_executor_profile_id(request))
}

pub(super) fn should_force_acp_fallback(request: &ProviderTurnRequest) -> bool {
    provider_option_bool(&request.provider_options, "force_acp_fallback")
}

pub(super) async fn apply_native_commit_reminder_to_request(
    state: &tauri::State<'_, AppState>,
    request: &mut ProviderTurnRequest,
    workspace_dir: &Path,
) {
    if provider_option_bool(&request.provider_options, "skip_commit_reminder") {
        return;
    }

    let config = state.deployment.config().read().await;
    if !config.commit_reminder_enabled {
        return;
    }
    if !native_commit_reminder_worktree_has_changes(state, workspace_dir) {
        return;
    }
    let reminder_prompt = config
        .commit_reminder_prompt
        .clone()
        .unwrap_or_else(|| DEFAULT_COMMIT_REMINDER_PROMPT.to_string());
    drop(config);

    request.text = native_commit_reminder_prompt_text(&request.text, reminder_prompt.trim());
}

fn native_commit_reminder_worktree_has_changes(
    state: &tauri::State<'_, AppState>,
    workspace_dir: &Path,
) -> bool {
    match state.deployment.git().get_worktree_status(workspace_dir) {
        Ok(status) => {
            native_commit_reminder_status_has_changes(status.uncommitted_tracked, status.untracked)
        }
        Err(error) => {
            tracing::debug!(
                workspace_dir = %workspace_dir.display(),
                ?error,
                "Skipping native commit reminder because worktree status is unavailable"
            );
            false
        }
    }
}

pub(super) fn native_commit_reminder_status_has_changes(
    uncommitted_tracked: usize,
    untracked: usize,
) -> bool {
    uncommitted_tracked > 0 || untracked > 0
}

pub(super) fn native_commit_reminder_prompt_text(prompt: &str, reminder_prompt: &str) -> String {
    format!(
        "{}\n\n<native-provider-commit-reminder-hook>\nAfter completing the requested work, check the repository status before your final response. If there are uncommitted changes, follow this commit reminder instruction:\n{}\n</native-provider-commit-reminder-hook>",
        prompt, reminder_prompt
    )
}

fn codex_approval_policy_value(approval: Option<&AskForApproval>) -> &'static str {
    match approval {
        Some(AskForApproval::UnlessTrusted) => "untrusted",
        Some(AskForApproval::OnFailure) => "on-failure",
        Some(AskForApproval::OnRequest) => "on-request",
        Some(AskForApproval::Never) | None => "never",
    }
}

fn codex_reasoning_effort_value(effort: &ReasoningEffort) -> &'static str {
    match effort {
        ReasoningEffort::Low => "low",
        ReasoningEffort::Medium => "medium",
        ReasoningEffort::High => "high",
        ReasoningEffort::Xhigh => "xhigh",
    }
}

fn codex_sandbox_policy_value(mode: Option<&SandboxMode>, workspace_dir: &Path) -> Value {
    match mode.unwrap_or(&SandboxMode::DangerFullAccess) {
        SandboxMode::Auto | SandboxMode::DangerFullAccess => json!({
            "type": "dangerFullAccess",
        }),
        SandboxMode::ReadOnly => json!({
            "type": "readOnly",
            "networkAccess": true,
        }),
        SandboxMode::WorkspaceWrite => json!({
            "type": "workspaceWrite",
            "writableRoots": [workspace_dir.to_string_lossy()],
            "networkAccess": true,
            "excludeTmpdirEnvVar": false,
            "excludeSlashTmp": false,
        }),
    }
}

fn codex_sandbox_mode_value(mode: Option<&SandboxMode>) -> &'static str {
    match mode.unwrap_or(&SandboxMode::DangerFullAccess) {
        SandboxMode::Auto | SandboxMode::DangerFullAccess => "danger-full-access",
        SandboxMode::ReadOnly => "read-only",
        SandboxMode::WorkspaceWrite => "workspace-write",
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct CodexRuntimeOptions {
    pub(super) model: Option<String>,
    pub(super) approval_policy: String,
    pub(super) sandbox_mode: String,
    pub(super) sandbox_policy: Value,
    pub(super) effort: Option<String>,
    pub(super) base_instructions: Option<String>,
    pub(super) fast_mode: Option<bool>,
}

fn codex_instruction_option(
    request: &ProviderTurnRequest,
    snake_case_key: &str,
    camel_case_key: &str,
) -> Option<String> {
    provider_option_string(&request.provider_options, snake_case_key)
        .or_else(|| provider_option_string(&request.provider_options, camel_case_key))
        .map(ToString::to_string)
}

fn codex_runtime_base_instructions(
    request: &ProviderTurnRequest,
    profile: Option<&executors::executors::codex::Codex>,
) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(base_instructions) =
        codex_instruction_option(request, "base_instructions", "baseInstructions")
            .or_else(|| profile.and_then(|codex| codex.base_instructions.clone()))
    {
        parts.push(base_instructions);
    }
    if let Some(developer_instructions) =
        codex_instruction_option(request, "developer_instructions", "developerInstructions")
            .or_else(|| profile.and_then(|codex| codex.developer_instructions.clone()))
    {
        parts.push(developer_instructions);
    }

    let instructions = parts
        .into_iter()
        .map(|part| part.trim().to_string())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    if instructions.is_empty() {
        None
    } else {
        Some(instructions)
    }
}

pub(super) fn resolve_codex_runtime_options(
    request: &ProviderTurnRequest,
    workspace_dir: &Path,
) -> CodexRuntimeOptions {
    let profile_id = provider_executor_profile_id(request);
    let agent = ExecutorConfigs::get_cached().get_coding_agent_or_default(&profile_id);
    let profile = match agent {
        CodingAgent::Codex(codex) => Some(codex),
        _ => None,
    };

    let model = request
        .model
        .clone()
        .or_else(|| profile_id.model.clone())
        .or_else(|| profile.as_ref().and_then(|codex| codex.model.clone()));
    let approval_policy = provider_option_string(&request.provider_options, "approval_policy")
        .or_else(|| provider_option_string(&request.provider_options, "approvalPolicy"))
        .map(ToString::to_string)
        .unwrap_or_else(|| {
            codex_approval_policy_value(
                profile
                    .as_ref()
                    .and_then(|codex| codex.ask_for_approval.as_ref()),
            )
            .into()
        });
    let sandbox_policy = request
        .provider_options
        .get("sandbox_policy")
        .or_else(|| request.provider_options.get("sandboxPolicy"))
        .cloned()
        .unwrap_or_else(|| {
            codex_sandbox_policy_value(
                profile.as_ref().and_then(|codex| codex.sandbox.as_ref()),
                workspace_dir,
            )
        });
    let sandbox_mode = provider_option_string(&request.provider_options, "sandbox")
        .or_else(|| provider_option_string(&request.provider_options, "sandbox_mode"))
        .or_else(|| provider_option_string(&request.provider_options, "sandboxMode"))
        .map(ToString::to_string)
        .unwrap_or_else(|| {
            codex_sandbox_mode_value(profile.as_ref().and_then(|codex| codex.sandbox.as_ref()))
                .to_string()
        });
    let effort = provider_option_string(&request.provider_options, "effort")
        .map(ToString::to_string)
        .or_else(|| {
            profile
                .as_ref()
                .and_then(|codex| codex.model_reasoning_effort.as_ref())
                .map(codex_reasoning_effort_value)
                .map(ToString::to_string)
        });
    let base_instructions = codex_runtime_base_instructions(request, profile.as_ref());
    let fast_mode = provider_option_optional_bool(&request.provider_options, "fast_mode")
        .or_else(|| provider_option_optional_bool(&request.provider_options, "fastMode"))
        .or(profile_id.fast_mode);

    CodexRuntimeOptions {
        model,
        approval_policy,
        sandbox_mode,
        sandbox_policy,
        effort,
        base_instructions,
        fast_mode,
    }
}

pub(super) fn apply_profile_defaults_to_request(request: &mut ProviderTurnRequest) {
    let profile_id = provider_executor_profile_id(request);
    if request.model.is_none() {
        request.model = profile_id.model.clone();
    }
    let agent = ExecutorConfigs::get_cached().get_coding_agent_or_default(&profile_id);

    match agent {
        CodingAgent::ClaudeCode(claude) => {
            request.text = claude.append_prompt.combine_prompt(&request.text);
            if request.model.is_none() {
                request.model = claude.model.clone();
            }
            if let Some(env) = claude.cmd.env {
                let profile_env = json!(env);
                match request.provider_options.get_mut("env") {
                    Some(Value::Object(existing)) => {
                        if let Some(profile_env) = profile_env.as_object() {
                            for (key, value) in profile_env {
                                existing.entry(key.clone()).or_insert_with(|| value.clone());
                            }
                        }
                    }
                    Some(_) => {}
                    None => {
                        request
                            .provider_options
                            .insert("env".to_string(), profile_env);
                    }
                }
            }
            if claude.plan.unwrap_or(false) {
                request
                    .provider_options
                    .entry("permission_mode".to_string())
                    .or_insert_with(|| json!("plan"));
            } else if claude.dangerously_skip_permissions.unwrap_or(false) {
                request
                    .provider_options
                    .entry("permission_mode".to_string())
                    .or_insert_with(|| json!("bypassPermissions"));
            }
        }
        CodingAgent::Opencode(opencode) => {
            request.text = opencode.append_prompt.combine_prompt(&request.text);
            if request.model.is_none() {
                request.model = opencode.model.clone();
            }
            if let Some(agent) = opencode.agent {
                request
                    .provider_options
                    .entry("agent".to_string())
                    .or_insert_with(|| json!(agent));
            }
            if let Some(variant) = opencode.variant {
                request
                    .provider_options
                    .entry("variant".to_string())
                    .or_insert_with(|| json!(variant));
            }
            if let Some(env) = opencode.cmd.env {
                let profile_env = json!(env);
                match request.provider_options.get_mut("env") {
                    Some(Value::Object(existing)) => {
                        if let Some(profile_env) = profile_env.as_object() {
                            for (key, value) in profile_env {
                                existing.entry(key.clone()).or_insert_with(|| value.clone());
                            }
                        }
                    }
                    Some(_) => {}
                    None => {
                        request
                            .provider_options
                            .insert("env".to_string(), profile_env);
                    }
                }
            }
            request
                .provider_options
                .entry("auto_approve".to_string())
                .or_insert_with(|| json!(opencode.auto_approve));
            request
                .provider_options
                .entry("auto_compact".to_string())
                .or_insert_with(|| json!(opencode.auto_compact));
        }
        CodingAgent::Codex(_) => {}
        #[cfg(feature = "qa-mode")]
        CodingAgent::QaMock(_) => {}
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct AcpFallbackConfig {
    pub(super) enabled: bool,
    pub(super) env_name: Option<&'static str>,
}

pub(super) fn provider_acp_fallback_env(provider: ProviderId) -> &'static str {
    match provider {
        ProviderId::Claude => CLAUDE_ACP_FALLBACK_ENV,
        ProviderId::Codex => CODEX_ACP_FALLBACK_ENV,
        ProviderId::Opencode => OPENCODE_ACP_FALLBACK_ENV,
    }
}

pub(super) fn parse_acp_fallback_enabled_value(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" | "enabled" => Some(true),
        "0" | "false" | "no" | "off" | "disabled" => Some(false),
        _ => None,
    }
}

pub(super) fn acp_fallback_config(provider: ProviderId) -> AcpFallbackConfig {
    let provider_env = provider_acp_fallback_env(provider);
    if let Ok(value) = std::env::var(provider_env) {
        return AcpFallbackConfig {
            enabled: parse_acp_fallback_enabled_value(&value).unwrap_or(true),
            env_name: Some(provider_env),
        };
    }
    if let Ok(value) = std::env::var(ACP_FALLBACK_ENV) {
        return AcpFallbackConfig {
            enabled: parse_acp_fallback_enabled_value(&value).unwrap_or(true),
            env_name: Some(ACP_FALLBACK_ENV),
        };
    }
    AcpFallbackConfig {
        enabled: true,
        env_name: None,
    }
}

pub(super) async fn new_provider_hidden_command(
    program: &str,
    args: Vec<String>,
) -> tokio::process::Command {
    let executable = utils::shell::resolve_executable_path(program)
        .await
        .unwrap_or_else(|| PathBuf::from(program));
    utils::process::new_hidden_tokio_command(executable, args)
}
