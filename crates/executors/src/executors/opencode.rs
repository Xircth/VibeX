use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use async_trait::async_trait;
use derivative::Derivative;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;
use workspace_utils::msg_store::MsgStore;

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

#[derive(Derivative, Clone, Serialize, Deserialize, TS, JsonSchema)]
#[derivative(Debug, PartialEq)]
pub struct Opencode {
    #[serde(default)]
    pub append_prompt: AppendPrompt,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none", alias = "mode")]
    pub agent: Option<String>,
    #[serde(default = "default_to_true")]
    pub auto_approve: bool,
    #[serde(default = "default_to_true")]
    pub auto_compact: bool,
    #[serde(flatten)]
    pub cmd: CmdOverrides,

    #[serde(skip)]
    #[ts(skip)]
    #[derivative(Debug = "ignore", PartialEq = "ignore")]
    pub approvals: Option<Arc<dyn ExecutorApprovalService>>,
}

impl Opencode {
    fn acp_executor(&self) -> AcpBackedExecutor {
        AcpBackedExecutor::new(AcpProvider::Opencode)
            .with_append_prompt(self.append_prompt.clone())
            .with_model(self.model.clone())
            .with_mode(self.agent.clone())
            .with_approvals_enabled(!self.auto_approve)
            .with_cmd(self.cmd.clone())
    }

    fn runtime_env(&self, env: &ExecutionEnv) -> ExecutionEnv {
        if !self.auto_compact {
            return env.clone();
        }

        let mut env = env.clone();
        let merged =
            merge_compaction_config(env.get("OPENCODE_CONFIG_CONTENT").map(String::as_str));
        env.insert("OPENCODE_CONFIG_CONTENT", merged);
        env
    }
}

#[async_trait]
impl StandardCodingAgentExecutor for Opencode {
    fn apply_overrides(&mut self, executor_config: &ExecutorConfig) {
        if let Some(model_id) = &executor_config.model_id {
            self.model = Some(model_id.clone());
        }
        if let Some(agent_id) = &executor_config.agent_id {
            self.agent = Some(agent_id.clone());
        }
        if let Some(permission_policy) = executor_config.permission_policy.clone() {
            self.auto_approve = matches!(permission_policy, PermissionPolicy::Auto);
        }
        if let Some(reasoning_id) = &executor_config.reasoning_id {
            self.variant = Some(reasoning_id.clone());
        }
    }

    fn use_approvals(&mut self, approvals: Arc<dyn ExecutorApprovalService>) {
        self.approvals = Some(approvals);
    }

    async fn available_slash_commands(
        &self,
        current_dir: &Path,
    ) -> Result<futures::stream::BoxStream<'static, json_patch::Patch>, ExecutorError> {
        self.acp_executor()
            .available_slash_commands(current_dir)
            .await
    }

    async fn spawn(
        &self,
        current_dir: &Path,
        prompt: &str,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        let mut executor = self.acp_executor();
        if let Some(approvals) = self.approvals.clone() {
            executor.use_approvals(approvals);
        }
        let env = self.runtime_env(env);
        executor.spawn(current_dir, prompt, &env).await
    }

    async fn spawn_follow_up(
        &self,
        current_dir: &Path,
        prompt: &str,
        session_id: &str,
        _reset_to_message_id: Option<&str>,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        let mut executor = self.acp_executor();
        if let Some(approvals) = self.approvals.clone() {
            executor.use_approvals(approvals);
        }
        let env = self.runtime_env(env);
        executor
            .spawn_follow_up(current_dir, prompt, session_id, None, &env)
            .await
    }

    fn normalize_logs(&self, msg_store: Arc<MsgStore>, worktree_path: &Path) {
        self.acp_executor().normalize_logs(msg_store, worktree_path);
    }

    fn default_mcp_config_path(&self) -> Option<PathBuf> {
        self.acp_executor().default_mcp_config_path()
    }

    fn get_availability_info(&self) -> AvailabilityInfo {
        self.acp_executor().get_availability_info()
    }
}

fn default_to_true() -> bool {
    true
}

fn merge_compaction_config(existing_json: Option<&str>) -> String {
    let mut config: Map<String, Value> = existing_json
        .and_then(|value| serde_json::from_str(value.trim()).ok())
        .unwrap_or_default();

    let mut compaction = config
        .remove("compaction")
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    compaction.insert("auto".to_string(), Value::Bool(true));
    config.insert("compaction".to_string(), Value::Object(compaction));

    serde_json::to_string(&config).unwrap_or_else(|_| r#"{"compaction":{"auto":true}}"#.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::RepoContext;

    #[test]
    fn opencode_auto_compact_merges_runtime_config() {
        let opencode = Opencode {
            append_prompt: AppendPrompt::default(),
            model: None,
            variant: None,
            agent: None,
            auto_approve: true,
            auto_compact: true,
            cmd: CmdOverrides::default(),
            approvals: None,
        };
        let mut env = ExecutionEnv::new(RepoContext::default(), false, String::new());
        env.insert("OPENCODE_CONFIG_CONTENT", r#"{"theme":"dark"}"#);

        let merged = opencode.runtime_env(&env);
        let value: Value = serde_json::from_str(
            merged
                .get("OPENCODE_CONFIG_CONTENT")
                .expect("config should be present"),
        )
        .expect("valid json");

        assert_eq!(value["theme"], "dark");
        assert_eq!(value["compaction"]["auto"], true);
    }

    #[test]
    fn opencode_variant_is_not_sent_as_acp_session_mode() {
        let opencode = Opencode {
            append_prompt: AppendPrompt::default(),
            model: None,
            variant: Some("high".to_string()),
            agent: None,
            auto_approve: true,
            auto_compact: true,
            cmd: CmdOverrides::default(),
            approvals: None,
        };

        let executor = opencode.acp_executor();

        assert_eq!(executor.mode, None);
    }

    #[test]
    fn opencode_agent_is_sent_as_acp_session_mode() {
        let opencode = Opencode {
            append_prompt: AppendPrompt::default(),
            model: None,
            variant: Some("high".to_string()),
            agent: Some("plan".to_string()),
            auto_approve: true,
            auto_compact: true,
            cmd: CmdOverrides::default(),
            approvals: None,
        };

        let executor = opencode.acp_executor();

        assert_eq!(executor.mode.as_deref(), Some("plan"));
    }
}
