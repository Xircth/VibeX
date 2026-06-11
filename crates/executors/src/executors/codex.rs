use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use async_trait::async_trait;
use derivative::Derivative;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum_macros::AsRefStr;
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

pub fn codex_home() -> Option<PathBuf> {
    if let Ok(codex_home) = std::env::var("CODEX_HOME")
        && !codex_home.trim().is_empty()
    {
        return Some(PathBuf::from(codex_home));
    }
    dirs::home_dir().map(|home| home.join(".codex"))
}

pub fn codex_config_model_context_window() -> Option<u32> {
    let path = codex_home()?.join("config.toml");
    let content = std::fs::read_to_string(path).ok()?;
    let value = content.parse::<toml::Value>().ok()?;
    value
        .get("model_context_window")
        .and_then(toml::Value::as_integer)
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value > 0)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, JsonSchema, AsRefStr)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case")]
pub enum SandboxMode {
    Auto,
    ReadOnly,
    WorkspaceWrite,
    DangerFullAccess,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, JsonSchema, AsRefStr)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case")]
pub enum AskForApproval {
    UnlessTrusted,
    OnFailure,
    OnRequest,
    Never,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, JsonSchema, AsRefStr)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case")]
pub enum ReasoningEffort {
    Low,
    Medium,
    High,
    Xhigh,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, JsonSchema, AsRefStr)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case")]
pub enum ReasoningSummary {
    Auto,
    Concise,
    Detailed,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS, JsonSchema, AsRefStr)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case")]
pub enum ReasoningSummaryFormat {
    None,
    Experimental,
}

#[derive(Derivative, Clone, Serialize, Deserialize, TS, JsonSchema)]
#[derivative(Debug, PartialEq)]
pub struct Codex {
    #[serde(default)]
    pub append_prompt: AppendPrompt,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<SandboxMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ask_for_approval: Option<AskForApproval>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oss: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_reasoning_effort: Option<ReasoningEffort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_reasoning_summary: Option<ReasoningSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_reasoning_summary_format: Option<ReasoningSummaryFormat>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_instructions: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub include_apply_patch_tool: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compact_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub developer_instructions: Option<String>,
    #[serde(flatten)]
    pub cmd: CmdOverrides,

    #[serde(skip)]
    #[ts(skip)]
    #[derivative(Debug = "ignore", PartialEq = "ignore")]
    approvals: Option<Arc<dyn ExecutorApprovalService>>,
}

impl Codex {
    fn effective_sandbox_mode(&self) -> SandboxMode {
        self.sandbox
            .clone()
            .unwrap_or(SandboxMode::DangerFullAccess)
    }

    fn sandbox_mode_value(mode: &SandboxMode) -> &'static str {
        match mode {
            SandboxMode::Auto => "danger-full-access",
            SandboxMode::ReadOnly => "read-only",
            SandboxMode::WorkspaceWrite => "workspace-write",
            SandboxMode::DangerFullAccess => "danger-full-access",
        }
    }

    fn approval_policy_value(approval: &AskForApproval) -> &'static str {
        match approval {
            AskForApproval::UnlessTrusted => "untrusted",
            AskForApproval::OnFailure => "on-failure",
            AskForApproval::OnRequest => "on-request",
            AskForApproval::Never => "never",
        }
    }

    fn push_config_override(params: &mut Vec<String>, key: &str, value: impl AsRef<str>) {
        params.extend(["-c".to_string(), format!("{key}={}", value.as_ref())]);
    }

    fn validate_acp_config(&self) -> Result<(), ExecutorError> {
        let mut unsupported = Vec::new();

        if self.oss.is_some() {
            unsupported.push("oss");
        }
        if self.base_instructions.is_some() {
            unsupported.push("base_instructions");
        }
        if self.include_apply_patch_tool.is_some() {
            unsupported.push("include_apply_patch_tool");
        }
        if self.model_provider.is_some() {
            unsupported.push("model_provider");
        }
        if self.compact_prompt.is_some() {
            unsupported.push("compact_prompt");
        }
        if self.developer_instructions.is_some() {
            unsupported.push("developer_instructions");
        }
        if self.model_reasoning_summary_format.is_some() {
            unsupported.push("model_reasoning_summary_format");
        }

        if unsupported.is_empty() {
            Ok(())
        } else {
            Err(ExecutorError::UnsupportedExecutorConfig(format!(
                "Codex ACP adapter does not support legacy field(s): {}",
                unsupported.join(", ")
            )))
        }
    }

    fn acp_cmd(&self) -> CmdOverrides {
        let mut cmd = self.cmd.clone();
        let mut params = cmd.additional_params.unwrap_or_default();

        Self::push_config_override(
            &mut params,
            "sandbox_mode",
            Self::sandbox_mode_value(&self.effective_sandbox_mode()),
        );
        if let Some(approval) = &self.ask_for_approval {
            Self::push_config_override(
                &mut params,
                "approval_policy",
                Self::approval_policy_value(approval),
            );
        }
        if let Some(model) = &self.model {
            Self::push_config_override(&mut params, "model", model);
        }
        if let Some(profile) = &self.profile {
            Self::push_config_override(&mut params, "profile", profile);
        }
        if let Some(effort) = &self.model_reasoning_effort {
            Self::push_config_override(&mut params, "model_reasoning_effort", effort.as_ref());
        }
        if let Some(summary) = &self.model_reasoning_summary {
            Self::push_config_override(&mut params, "model_reasoning_summary", summary.as_ref());
        }

        cmd.additional_params = (!params.is_empty()).then_some(params);
        cmd
    }
}

#[async_trait]
impl StandardCodingAgentExecutor for Codex {
    fn apply_overrides(&mut self, executor_config: &ExecutorConfig) {
        if let Some(model_id) = &executor_config.model_id {
            self.model = Some(model_id.clone());
        }

        if let Some(reasoning_id) = &executor_config.reasoning_id {
            let normalized = reasoning_id.trim().to_ascii_lowercase();
            self.model_reasoning_effort = match normalized.as_str() {
                "low" => Some(ReasoningEffort::Low),
                "medium" => Some(ReasoningEffort::Medium),
                "high" => Some(ReasoningEffort::High),
                "xhigh" | "x-high" => Some(ReasoningEffort::Xhigh),
                _ => self.model_reasoning_effort.clone(),
            };
        }

        if let Some(permission_policy) = &executor_config.permission_policy {
            match permission_policy {
                PermissionPolicy::Auto => self.ask_for_approval = Some(AskForApproval::Never),
                PermissionPolicy::Supervised => {
                    if matches!(self.ask_for_approval, None | Some(AskForApproval::Never)) {
                        self.ask_for_approval = Some(AskForApproval::UnlessTrusted);
                    }
                }
                PermissionPolicy::Plan => {
                    self.ask_for_approval = Some(AskForApproval::OnRequest);
                }
            }
        }
    }

    fn use_approvals(&mut self, approvals: Arc<dyn ExecutorApprovalService>) {
        self.approvals = Some(approvals);
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

    async fn spawn_review(
        &self,
        _current_dir: &Path,
        _prompt: &str,
        _session_id: Option<&str>,
        _env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        Err(legacy_agent_runtime_removed())
    }

    fn normalize_logs(&self, _msg_store: Arc<MsgStore>, _worktree_path: &Path) {}

    fn default_mcp_config_path(&self) -> Option<PathBuf> {
        codex_home().map(|home| home.join("config.toml"))
    }

    fn get_availability_info(&self) -> AvailabilityInfo {
        if let Some(timestamp) = codex_home()
            .and_then(|home| std::fs::metadata(home.join("auth.json")).ok())
            .and_then(|metadata| metadata.modified().ok())
            .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs() as i64)
        {
            return AvailabilityInfo::LoginDetected {
                last_auth_timestamp: timestamp,
            };
        }

        let indicator = codex_home()
            .map(|home| home.join("version.json").exists() || home.join("config.toml").exists())
            .unwrap_or(false);
        if indicator {
            AvailabilityInfo::InstallationFound
        } else {
            AvailabilityInfo::NotFound
        }
    }

    async fn get_setup_helper_action(
        &self,
    ) -> Result<crate::actions::ExecutorAction, ExecutorError> {
        Err(legacy_agent_runtime_removed())
    }
}

fn legacy_agent_runtime_removed() -> ExecutorError {
    ExecutorError::UnsupportedExecutorConfig(
        "legacy Codex executor runtime was removed; use crates/agents ACP runtime".to_string(),
    )
}
