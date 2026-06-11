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

    fn normalize_logs(&self, _msg_store: Arc<MsgStore>, _worktree_path: &Path) {}

    fn default_mcp_config_path(&self) -> Option<PathBuf> {
        opencode_config_path()
    }

    fn get_availability_info(&self) -> AvailabilityInfo {
        if opencode_config_path()
            .map(|path| path.exists())
            .unwrap_or(false)
        {
            AvailabilityInfo::InstallationFound
        } else {
            AvailabilityInfo::NotFound
        }
    }
}

fn legacy_agent_runtime_removed() -> ExecutorError {
    ExecutorError::UnsupportedExecutorConfig(
        "legacy OpenCode executor runtime was removed; use crates/agents ACP runtime".to_string(),
    )
}

fn opencode_config_path() -> Option<PathBuf> {
    #[cfg(not(windows))]
    {
        let base_dirs = xdg::BaseDirectories::with_prefix("opencode");
        base_dirs
            .get_config_file("opencode.json")
            .filter(|path| path.exists())
            .or_else(|| base_dirs.get_config_file("opencode.jsonc"))
    }
    #[cfg(windows)]
    {
        let config_dir = std::env::var("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .ok()
            .or_else(|| dirs::home_dir().map(|home| home.join("AppData").join("Roaming")))
            .map(|base| base.join("opencode"));
        config_dir.and_then(|dir| {
            let json = dir.join("opencode.json");
            if json.exists() {
                Some(json)
            } else {
                Some(dir.join("opencode.jsonc"))
            }
        })
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
}
