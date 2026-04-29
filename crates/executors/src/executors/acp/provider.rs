use std::{path::PathBuf, sync::Arc};

use async_trait::async_trait;
use workspace_utils::msg_store::MsgStore;

use crate::{
    actions::{ExecutorAction, script::ScriptRequest},
    approvals::ExecutorApprovalService,
    command::{CmdOverrides, CommandBuildError, CommandBuilder, apply_overrides},
    env::ExecutionEnv,
    executors::{
        AppendPrompt, AvailabilityInfo, BaseAgentCapability, ExecutorError,
        SlashCommandDescription, SpawnedChild, StandardCodingAgentExecutor,
        acp::{AcpAgentHarness, normalize_logs},
    },
    logs::utils::patch,
    profile::ExecutorConfig,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcpProvider {
    ClaudeCode,
    Codex,
    Opencode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcpSessionContinuity {
    ForkSnapshot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AcpProviderCapabilities {
    pub session_continuity: AcpSessionContinuity,
    pub setup_helper: bool,
    pub context_usage: bool,
    pub slash_commands: bool,
}

impl AcpProvider {
    pub fn session_namespace(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude_code_acp_sessions",
            Self::Codex => "codex_acp_sessions",
            Self::Opencode => "opencode_acp_sessions",
        }
    }

    pub fn default_base_command(self) -> &'static str {
        match self {
            Self::ClaudeCode => "npx -y @agentclientprotocol/claude-agent-acp",
            Self::Codex => "npx -y @zed-industries/codex-acp",
            Self::Opencode => "opencode acp",
        }
    }

    pub fn capabilities(self) -> AcpProviderCapabilities {
        AcpProviderCapabilities {
            session_continuity: AcpSessionContinuity::ForkSnapshot,
            setup_helper: matches!(self, Self::Codex),
            context_usage: true,
            slash_commands: true,
        }
    }

    pub fn base_capabilities(self) -> Vec<BaseAgentCapability> {
        let caps = self.capabilities();
        let mut out = vec![
            BaseAgentCapability::SessionFork,
            BaseAgentCapability::ContextUsage,
        ];
        if caps.setup_helper {
            out.push(BaseAgentCapability::SetupHelper);
        }
        out
    }

    pub fn default_mcp_config_path(self) -> Option<PathBuf> {
        match self {
            Self::ClaudeCode => dirs::home_dir().map(|home| home.join(".claude.json")),
            Self::Codex => codex_home().map(|home| home.join("config.toml")),
            Self::Opencode => opencode_config_path(),
        }
    }

    pub fn availability_info(self) -> AvailabilityInfo {
        match self {
            Self::ClaudeCode => {
                availability_from_auth_file(Self::ClaudeCode.default_mcp_config_path())
            }
            Self::Codex => {
                if let Some(timestamp) = codex_home()
                    .and_then(|home| std::fs::metadata(home.join("auth.json")).ok())
                    .and_then(|m| m.modified().ok())
                    .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                {
                    return AvailabilityInfo::LoginDetected {
                        last_auth_timestamp: timestamp,
                    };
                }

                let indicator = codex_home()
                    .map(|home| {
                        home.join("version.json").exists() || home.join("config.toml").exists()
                    })
                    .unwrap_or(false);
                if indicator {
                    AvailabilityInfo::InstallationFound
                } else {
                    AvailabilityInfo::NotFound
                }
            }
            Self::Opencode => {
                let config_found = Self::Opencode
                    .default_mcp_config_path()
                    .map(|path| path.exists())
                    .unwrap_or(false);
                let home_found = dirs::home_dir()
                    .map(|home| home.join(".opencode").exists())
                    .unwrap_or(false);
                if config_found || home_found {
                    AvailabilityInfo::InstallationFound
                } else {
                    AvailabilityInfo::NotFound
                }
            }
        }
    }
}

fn availability_from_auth_file(path: Option<PathBuf>) -> AvailabilityInfo {
    if let Some(timestamp) = path
        .and_then(|p| std::fs::metadata(p).ok())
        .and_then(|m| m.modified().ok())
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
    {
        AvailabilityInfo::LoginDetected {
            last_auth_timestamp: timestamp,
        }
    } else {
        AvailabilityInfo::NotFound
    }
}

pub fn codex_home() -> Option<PathBuf> {
    if let Ok(codex_home) = std::env::var("CODEX_HOME")
        && !codex_home.trim().is_empty()
    {
        return Some(PathBuf::from(codex_home));
    }
    dirs::home_dir().map(|home| home.join(".codex"))
}

fn opencode_config_path() -> Option<PathBuf> {
    #[cfg(not(windows))]
    {
        let base_dirs = xdg::BaseDirectories::with_prefix("opencode");
        base_dirs
            .get_config_file("opencode.json")
            .filter(|p| p.exists())
            .or_else(|| base_dirs.get_config_file("opencode.jsonc"))
    }
    #[cfg(windows)]
    {
        let config_dir = std::env::var("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .ok()
            .or_else(|| dirs::home_dir().map(|p| p.join(".config")))
            .map(|p| p.join("opencode"))?;

        Some(config_dir.join("opencode.json"))
            .filter(|p| p.exists())
            .or_else(|| Some(config_dir.join("opencode.jsonc")).filter(|p| p.exists()))
    }
}

#[derive(Clone)]
pub struct AcpBackedExecutor {
    pub provider: AcpProvider,
    pub append_prompt: AppendPrompt,
    pub model: Option<String>,
    pub mode: Option<String>,
    pub approvals_enabled: bool,
    pub cmd: CmdOverrides,
    approvals: Option<Arc<dyn ExecutorApprovalService>>,
}

impl AcpBackedExecutor {
    pub fn new(provider: AcpProvider) -> Self {
        Self {
            provider,
            append_prompt: AppendPrompt::default(),
            model: None,
            mode: None,
            approvals_enabled: false,
            cmd: CmdOverrides::default(),
            approvals: None,
        }
    }

    pub fn with_append_prompt(mut self, append_prompt: AppendPrompt) -> Self {
        self.append_prompt = append_prompt;
        self
    }

    pub fn with_model(mut self, model: Option<String>) -> Self {
        self.model = model;
        self
    }

    pub fn with_mode(mut self, mode: Option<String>) -> Self {
        self.mode = mode;
        self
    }

    pub fn with_approvals_enabled(mut self, enabled: bool) -> Self {
        self.approvals_enabled = enabled;
        self
    }

    pub fn with_cmd(mut self, cmd: CmdOverrides) -> Self {
        self.cmd = cmd;
        self
    }

    fn build_command_builder(&self) -> Result<CommandBuilder, CommandBuildError> {
        apply_overrides(
            CommandBuilder::new(self.provider.default_base_command()),
            &self.cmd,
        )
    }

    fn harness(&self) -> AcpAgentHarness {
        let mut harness =
            AcpAgentHarness::with_session_namespace(self.provider.session_namespace());
        if let Some(model) = &self.model {
            harness = harness.with_model(model.clone());
        }
        if let Some(mode) = &self.mode {
            harness = harness.with_mode(mode.clone());
        }
        harness
    }

    fn approvals_for_run(&self) -> Option<Arc<dyn ExecutorApprovalService>> {
        if self.approvals_enabled {
            self.approvals.clone()
        } else {
            None
        }
    }
}

#[async_trait]
impl StandardCodingAgentExecutor for AcpBackedExecutor {
    fn apply_overrides(&mut self, executor_config: &ExecutorConfig) {
        if let Some(model_id) = &executor_config.model_id {
            self.model = Some(model_id.clone());
        }
        if let Some(agent_id) = &executor_config.agent_id {
            self.mode = Some(agent_id.clone());
        }
        if let Some(reasoning_id) = &executor_config.reasoning_id
            && self.provider == AcpProvider::Codex
        {
            self.mode = Some(reasoning_id.clone());
        }
        if let Some(permission_policy) = executor_config.permission_policy.clone() {
            self.approvals_enabled = !matches!(
                permission_policy,
                crate::model_selector::PermissionPolicy::Auto
            );
            if matches!(
                permission_policy,
                crate::model_selector::PermissionPolicy::Plan
            ) {
                self.mode = Some("plan".to_string());
            }
        }
    }

    fn use_approvals(&mut self, approvals: Arc<dyn ExecutorApprovalService>) {
        self.approvals = Some(approvals);
    }

    async fn available_slash_commands(
        &self,
        _workdir: &std::path::Path,
    ) -> Result<futures::stream::BoxStream<'static, json_patch::Patch>, ExecutorError> {
        let commands = vec![
            SlashCommandDescription {
                name: "help".to_string(),
                description: Some("show available ACP adapter commands".to_string()),
            },
            SlashCommandDescription {
                name: "compact".to_string(),
                description: Some(
                    "compact or summarize the current session when supported".to_string(),
                ),
            },
        ];
        Ok(Box::pin(futures::stream::once(async move {
            patch::slash_commands(commands, false, None)
        })))
    }

    async fn spawn(
        &self,
        current_dir: &std::path::Path,
        prompt: &str,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        let command_parts = self.build_command_builder()?.build_initial()?;
        self.harness()
            .spawn_with_command(
                current_dir,
                self.append_prompt.combine_prompt(prompt),
                command_parts,
                env,
                &self.cmd,
                self.approvals_for_run(),
            )
            .await
    }

    async fn spawn_follow_up(
        &self,
        current_dir: &std::path::Path,
        prompt: &str,
        session_id: &str,
        _reset_to_message_id: Option<&str>,
        env: &ExecutionEnv,
    ) -> Result<SpawnedChild, ExecutorError> {
        let command_parts = self.build_command_builder()?.build_initial()?;
        self.harness()
            .spawn_follow_up_with_command(
                current_dir,
                self.append_prompt.combine_prompt(prompt),
                session_id,
                command_parts,
                env,
                &self.cmd,
                self.approvals_for_run(),
            )
            .await
    }

    fn normalize_logs(&self, msg_store: Arc<MsgStore>, worktree_path: &std::path::Path) {
        normalize_logs(msg_store, worktree_path);
    }

    fn default_mcp_config_path(&self) -> Option<PathBuf> {
        self.provider.default_mcp_config_path()
    }

    fn get_availability_info(&self) -> AvailabilityInfo {
        self.provider.availability_info()
    }

    async fn get_setup_helper_action(&self) -> Result<ExecutorAction, ExecutorError> {
        if !self.provider.capabilities().setup_helper {
            return Err(ExecutorError::SetupHelperNotSupported);
        }

        let login_request = ScriptRequest {
            script: "npx -y @zed-industries/codex-acp login".to_string(),
            language: crate::actions::script::ScriptRequestLanguage::Bash,
            context: crate::actions::script::ScriptContext::ToolInstallScript,
            working_dir: None,
        };

        Ok(ExecutorAction::new(
            crate::actions::ExecutorActionType::ScriptRequest(login_request),
            None,
        ))
    }
}
