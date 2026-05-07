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

pub use crate::executors::acp::codex_home;
use crate::{
    approvals::ExecutorApprovalService,
    command::CmdOverrides,
    env::ExecutionEnv,
    executors::{
        AppendPrompt, AvailabilityInfo, ExecutorError, SpawnedChild, StandardCodingAgentExecutor,
        acp::{AcpBackedExecutor, AcpProvider},
    },
    model_selector::PermissionPolicy,
    profile::ExecutorConfig,
};

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

    fn acp_executor(&self) -> Result<AcpBackedExecutor, ExecutorError> {
        self.validate_acp_config()?;

        Ok(AcpBackedExecutor::new(AcpProvider::Codex)
            .with_append_prompt(self.append_prompt.clone())
            .with_model(self.model.clone())
            .with_mode(
                self.model_reasoning_effort
                    .as_ref()
                    .map(|effort| effort.as_ref().to_string()),
            )
            .with_approvals_enabled(!matches!(
                self.ask_for_approval,
                None | Some(AskForApproval::Never)
            ))
            .with_cmd(self.acp_cmd()))
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

    async fn available_slash_commands(
        &self,
        workdir: &Path,
    ) -> Result<futures::stream::BoxStream<'static, json_patch::Patch>, ExecutorError> {
        self.acp_executor()?.available_slash_commands(workdir).await
    }

    async fn spawn(
        &self,
        current_dir: &Path,
        prompt: &str,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        let mut executor = self.acp_executor()?;
        if let Some(approvals) = self.approvals.clone() {
            executor.use_approvals(approvals);
        }
        executor.spawn(current_dir, prompt, env).await
    }

    async fn spawn_follow_up(
        &self,
        current_dir: &Path,
        prompt: &str,
        session_id: &str,
        _reset_to_message_id: Option<&str>,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        let mut executor = self.acp_executor()?;
        if let Some(approvals) = self.approvals.clone() {
            executor.use_approvals(approvals);
        }
        executor
            .spawn_follow_up(current_dir, prompt, session_id, None, env)
            .await
    }

    async fn spawn_review(
        &self,
        current_dir: &Path,
        prompt: &str,
        session_id: Option<&str>,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        let mut executor = self.acp_executor()?;
        if let Some(approvals) = self.approvals.clone() {
            executor.use_approvals(approvals);
        }
        executor
            .spawn_review(current_dir, prompt, session_id, env)
            .await
    }

    fn normalize_logs(&self, msg_store: Arc<MsgStore>, worktree_path: &Path) {
        match self.acp_executor() {
            Ok(executor) => executor.normalize_logs(msg_store, worktree_path),
            Err(err) => tracing::warn!("Cannot normalize Codex ACP logs: {err}"),
        }
    }

    fn default_mcp_config_path(&self) -> Option<PathBuf> {
        AcpBackedExecutor::new(AcpProvider::Codex).default_mcp_config_path()
    }

    fn get_availability_info(&self) -> AvailabilityInfo {
        AcpBackedExecutor::new(AcpProvider::Codex).get_availability_info()
    }

    async fn get_setup_helper_action(
        &self,
    ) -> Result<crate::actions::ExecutorAction, ExecutorError> {
        self.acp_executor()?.get_setup_helper_action().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn has_config_override(params: &[String], key: &str, value: &str) -> bool {
        params
            .windows(2)
            .any(|w| w[0] == "-c" && w[1] == format!("{key}={value}"))
    }

    #[test]
    fn codex_maps_supported_acp_command_params() {
        let codex = Codex {
            append_prompt: AppendPrompt::default(),
            sandbox: Some(SandboxMode::WorkspaceWrite),
            ask_for_approval: Some(AskForApproval::UnlessTrusted),
            oss: None,
            model: Some("gpt-5.4".to_string()),
            model_reasoning_effort: Some(ReasoningEffort::High),
            model_reasoning_summary: None,
            model_reasoning_summary_format: None,
            profile: Some("default".to_string()),
            base_instructions: None,
            include_apply_patch_tool: None,
            model_provider: None,
            compact_prompt: None,
            developer_instructions: None,
            cmd: CmdOverrides::default(),
            approvals: None,
        };

        let executor = codex.acp_executor().expect("config should be supported");
        let params = executor.cmd.additional_params.expect("params");

        assert!(has_config_override(
            &params,
            "sandbox_mode",
            "workspace-write"
        ));
        assert!(has_config_override(&params, "approval_policy", "untrusted"));
        assert!(has_config_override(&params, "model", "gpt-5.4"));
        assert!(has_config_override(&params, "profile", "default"));
        assert!(has_config_override(
            &params,
            "model_reasoning_effort",
            "high"
        ));
        assert!(!params.iter().any(|param| param.starts_with("--")));
        assert!(executor.approvals_enabled);
    }

    #[test]
    fn codex_rejects_unsupported_legacy_fields() {
        let codex = Codex {
            append_prompt: AppendPrompt::default(),
            sandbox: None,
            ask_for_approval: None,
            oss: Some(true),
            model: None,
            model_reasoning_effort: None,
            model_reasoning_summary: None,
            model_reasoning_summary_format: None,
            profile: None,
            base_instructions: None,
            include_apply_patch_tool: None,
            model_provider: None,
            compact_prompt: None,
            developer_instructions: None,
            cmd: CmdOverrides::default(),
            approvals: None,
        };

        assert!(matches!(
            codex.acp_executor(),
            Err(ExecutorError::UnsupportedExecutorConfig(_))
        ));
    }

    #[test]
    fn codex_command_params_default_to_full_access_config_override() {
        let codex = Codex {
            append_prompt: AppendPrompt::default(),
            sandbox: None,
            ask_for_approval: None,
            oss: None,
            model: Some("gpt-5.4".to_string()),
            model_reasoning_effort: None,
            model_reasoning_summary: None,
            model_reasoning_summary_format: None,
            profile: None,
            base_instructions: None,
            include_apply_patch_tool: None,
            model_provider: None,
            compact_prompt: None,
            developer_instructions: None,
            cmd: CmdOverrides::default(),
            approvals: None,
        };

        let executor = codex.acp_executor().expect("config should be supported");
        let params = executor.cmd.additional_params.expect("params");

        assert!(has_config_override(
            &params,
            "sandbox_mode",
            "danger-full-access"
        ));
    }

    #[test]
    fn codex_rejects_unsupported_reasoning_summary_format() {
        let codex = Codex {
            append_prompt: AppendPrompt::default(),
            sandbox: None,
            ask_for_approval: None,
            oss: None,
            model: None,
            model_reasoning_effort: None,
            model_reasoning_summary: None,
            model_reasoning_summary_format: Some(ReasoningSummaryFormat::Experimental),
            profile: None,
            base_instructions: None,
            include_apply_patch_tool: None,
            model_provider: None,
            compact_prompt: None,
            developer_instructions: None,
            cmd: CmdOverrides::default(),
            approvals: None,
        };

        assert!(matches!(
            codex.acp_executor(),
            Err(ExecutorError::UnsupportedExecutorConfig(_))
        ));
    }
}
