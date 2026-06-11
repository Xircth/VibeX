use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Arc,
};

use async_trait::async_trait;
use derivative::Derivative;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use workspace_utils::msg_store::MsgStore;

use crate::{
    approvals::ExecutorApprovalService,
    command::CmdOverrides,
    env::ExecutionEnv,
    executors::{
        AppendPrompt, AvailabilityInfo, ExecutorError, SpawnedChild, StandardCodingAgentExecutor,
    },
    model_selector::PermissionPolicy,
    profile::ExecutorConfig,
};

#[derive(Derivative, Clone, Serialize, Deserialize, TS, JsonSchema)]
#[derivative(Debug, PartialEq)]
pub struct ClaudeCode {
    #[serde(default)]
    pub append_prompt: AppendPrompt,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude_code_router: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approvals: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dangerously_skip_permissions: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disable_api_key: Option<bool>,
    #[serde(flatten)]
    pub cmd: CmdOverrides,

    #[serde(skip)]
    #[ts(skip)]
    #[derivative(Debug = "ignore", PartialEq = "ignore")]
    approvals_service: Option<Arc<dyn ExecutorApprovalService>>,
}

impl ClaudeCode {
    fn model_for_acp(&self) -> Option<String> {
        self.model
            .as_deref()
            .and_then(resolve_claude_model_alias)
            .or_else(|| self.model.clone())
    }

    fn acp_mode(&self) -> Option<String> {
        if self.plan.unwrap_or(false) {
            Some("plan".to_string())
        } else if self.dangerously_skip_permissions.unwrap_or(false) {
            Some("bypassPermissions".to_string())
        } else {
            None
        }
    }

    fn validate_acp_config(&self) -> Result<(), ExecutorError> {
        let mut unsupported = Vec::new();

        if self.claude_code_router.is_some() {
            unsupported.push("claude_code_router");
        }
        if self.disable_api_key.is_some() {
            unsupported.push("disable_api_key");
        }

        if unsupported.is_empty() {
            Ok(())
        } else {
            Err(ExecutorError::UnsupportedExecutorConfig(format!(
                "Claude ACP adapter does not support legacy field(s): {}",
                unsupported.join(", ")
            )))
        }
    }
}

fn resolve_claude_model_alias(model: &str) -> Option<String> {
    let env_key = match model.trim().to_ascii_lowercase().as_str() {
        "sonnet" => "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "opus" => "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "haiku" => "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        _ => return None,
    };

    read_claude_model_env()
        .get(env_key)
        .cloned()
        .or_else(|| normalize_non_empty(std::env::var(env_key).ok()))
}

fn normalize_non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn claude_settings_path() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|home| PathBuf::from(home).join(".claude").join("settings.json"))
}

fn read_claude_model_env() -> HashMap<String, String> {
    let Some(path) = claude_settings_path() else {
        return HashMap::new();
    };
    let Ok(content) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };
    let Ok(root) = serde_json::from_str::<serde_json::Value>(&content) else {
        return HashMap::new();
    };
    root.get("env")
        .and_then(|value| serde_json::from_value(value.clone()).ok())
        .unwrap_or_default()
}

#[async_trait]
impl StandardCodingAgentExecutor for ClaudeCode {
    fn apply_overrides(&mut self, executor_config: &ExecutorConfig) {
        if let Some(model_id) = &executor_config.model_id {
            self.model = Some(model_id.clone());
        }

        if let Some(permission_policy) = executor_config.permission_policy.clone() {
            match permission_policy {
                PermissionPolicy::Plan => {
                    self.plan = Some(true);
                    self.approvals = Some(false);
                }
                PermissionPolicy::Supervised => {
                    self.plan = Some(false);
                    self.approvals = Some(true);
                }
                PermissionPolicy::Auto => {
                    self.plan = Some(false);
                    self.approvals = Some(false);
                }
            }
        }
    }

    fn use_approvals(&mut self, approvals: Arc<dyn ExecutorApprovalService>) {
        self.approvals_service = Some(approvals);
    }

    async fn spawn(
        &self,
        _current_dir: &Path,
        _prompt: &str,
        _env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        Err(legacy_agent_runtime_removed())
    }

    async fn spawn_follow_up(
        &self,
        _current_dir: &Path,
        _prompt: &str,
        _session_id: &str,
        _reset_to_message_id: Option<&str>,
        _env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        Err(legacy_agent_runtime_removed())
    }

    fn normalize_logs(&self, _msg_store: Arc<MsgStore>, _current_dir: &Path) {}

    fn default_mcp_config_path(&self) -> Option<PathBuf> {
        dirs::home_dir().map(|home| home.join(".claude.json"))
    }

    fn get_availability_info(&self) -> AvailabilityInfo {
        self.default_mcp_config_path()
            .and_then(|path| std::fs::metadata(path).ok())
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| AvailabilityInfo::LoginDetected {
                last_auth_timestamp: duration.as_secs() as i64,
            })
            .unwrap_or(AvailabilityInfo::NotFound)
    }
}

fn legacy_agent_runtime_removed() -> ExecutorError {
    ExecutorError::UnsupportedExecutorConfig(
        "legacy Claude executor runtime was removed; use crates/agents ACP runtime".to_string(),
    )
}
