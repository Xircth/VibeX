use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::Arc,
};

use async_trait::async_trait;
use workspace_utils::{msg_store::MsgStore, shell::resolve_executable_path};

use crate::{
    actions::{ExecutorAction, script::ScriptRequest},
    approvals::ExecutorApprovalService,
    command::{CmdOverrides, CommandBuildError, CommandBuilder, CommandParts, apply_overrides},
    env::ExecutionEnv,
    executors::{
        AppendPrompt, AvailabilityInfo, BaseAgentCapability, ExecutorError,
        SlashCommandDescription, SlashCommandKind, SpawnedChild, StandardCodingAgentExecutor,
        acp::{AcpAgentHarness, normalize_logs, normalize_logs_with_context_window_override},
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

    fn local_base_command(self) -> (&'static str, &'static str) {
        match self {
            Self::ClaudeCode => (
                local_claude_agent_acp_command(),
                local_claude_agent_acp_command(),
            ),
            Self::Codex => (local_codex_acp_command(), local_codex_acp_command()),
            Self::Opencode => (local_opencode_command(), local_opencode_acp_command()),
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

    fn builtin_slash_commands(self) -> Vec<SlashCommandDescription> {
        match self {
            Self::ClaudeCode => slash_commands(&[
                ("add-dir", "Add additional working directories"),
                ("agents", "Manage custom agents"),
                ("bug", "Report bugs"),
                ("clear", "Clear conversation history"),
                ("compact", "Compact conversation with an optional focus"),
                ("context", "Show context usage"),
                ("cost", "Show token usage and cost"),
                ("doctor", "Check Claude Code installation health"),
                ("export", "Export the current conversation"),
                ("help", "Show Claude Code help"),
                ("hooks", "Manage hook configuration"),
                ("ide", "Manage IDE integrations"),
                ("init", "Initialize a CLAUDE.md file"),
                (
                    "install-github-app",
                    "Set up GitHub pull request integration",
                ),
                ("login", "Switch Anthropic accounts"),
                ("logout", "Sign out of the current Anthropic account"),
                ("memory", "Edit CLAUDE.md memory files"),
                (
                    "migrate-installer",
                    "Migrate to a local Claude Code installation",
                ),
                ("output-style", "Select or create an output style"),
                ("pr-comments", "Fetch comments from a GitHub pull request"),
                ("release-notes", "View release notes"),
                ("resume", "Resume a conversation"),
                ("review", "Review a pull request"),
                ("security-review", "Review code for security issues"),
                ("status", "Show account and system status"),
                ("terminal-setup", "Install Shift+Enter terminal key binding"),
                ("todos", "List current todos"),
                ("upgrade", "Upgrade Claude Code"),
                ("vim", "Toggle Vim mode"),
            ]),
            Self::Codex => slash_commands(&[
                ("compact", "Compact conversation with an optional focus"),
                (
                    "goal",
                    "Set, inspect, pause, resume, or clear a long-running goal",
                ),
                ("review", "Review code with optional instructions"),
                (
                    "init",
                    "Create an AGENTS.md file with repository instructions",
                ),
            ]),
            Self::Opencode => slash_commands(&[
                ("init", "Create or update AGENTS.md"),
                ("undo", "Revert the last change"),
                ("redo", "Reapply the last reverted change"),
                ("models", "List available models"),
                ("share", "Share the current session"),
                ("unshare", "Stop sharing the current session"),
                ("compact", "Compact the current session"),
                ("summarize", "Summarize the current session"),
                ("status", "Show current status"),
                ("help", "Show OpenCode help"),
                ("exit", "Exit OpenCode"),
                ("quit", "Exit OpenCode"),
                ("sessions", "List sessions"),
                ("session", "Manage or switch sessions"),
                ("new", "Start a new session"),
                ("messages", "Show message history"),
                ("terminal", "Toggle terminal panel"),
                ("agents", "List or switch agents"),
                ("commands", "Show available commands"),
                ("plan", "Switch to plan mode"),
                ("build", "Switch to build mode"),
                ("project", "Open project information"),
                ("thinking", "Toggle thinking display"),
                ("login", "Sign in"),
                ("logout", "Sign out"),
                ("upgrade", "Upgrade OpenCode"),
            ]),
        }
    }

    fn slash_commands_for_workdir(self, workdir: &Path) -> Vec<SlashCommandDescription> {
        let mut commands = self.builtin_slash_commands();
        match self {
            Self::ClaudeCode => {
                discover_markdown_commands(
                    &mut commands,
                    &project_and_home_dirs(workdir, ".claude", "commands"),
                    "Claude Code custom command",
                );
                discover_skill_commands(
                    &mut commands,
                    &project_and_home_dirs(workdir, ".claude", "skills"),
                    "Claude Code skill",
                );
            }
            Self::Codex => {
                discover_markdown_commands(
                    &mut commands,
                    &project_and_home_dirs(workdir, ".codex", "prompts"),
                    "Codex custom prompt",
                );
                discover_skill_commands(&mut commands, &codex_skill_dirs(workdir), "Codex skill");
            }
            Self::Opencode => {
                discover_markdown_commands(
                    &mut commands,
                    &opencode_command_dirs(workdir),
                    "OpenCode custom command",
                );
            }
        }
        commands
    }
}

fn slash_commands(entries: &[(&str, &str)]) -> Vec<SlashCommandDescription> {
    entries
        .iter()
        .map(|(name, description)| SlashCommandDescription {
            name: (*name).to_string(),
            description: Some((*description).to_string()),
            kind: Some(SlashCommandKind::Command),
        })
        .collect()
}

fn add_command_if_missing(
    commands: &mut Vec<SlashCommandDescription>,
    seen: &mut BTreeSet<String>,
    name: String,
    description: Option<String>,
    kind: SlashCommandKind,
) {
    let name = name
        .trim()
        .trim_start_matches('/')
        .trim_start_matches('$')
        .to_string();
    if name.is_empty() || !seen.insert(name.clone()) {
        return;
    }
    commands.push(SlashCommandDescription {
        name,
        description,
        kind: Some(kind),
    });
}

fn existing_command_names(commands: &[SlashCommandDescription]) -> BTreeSet<String> {
    commands
        .iter()
        .map(|command| command.name.clone())
        .collect()
}

fn project_and_home_dirs(workdir: &Path, root: &str, leaf: &str) -> Vec<PathBuf> {
    let mut dirs = vec![workdir.join(root).join(leaf)];
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(root).join(leaf));
    }
    dirs
}

fn codex_skill_dirs(workdir: &Path) -> Vec<PathBuf> {
    let mut dirs = project_and_home_dirs(workdir, ".codex", "skills");
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".agents").join("skills"));
    }
    dirs
}

fn opencode_command_dirs(workdir: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![
        workdir.join(".opencode").join("commands"),
        workdir.join("opencode").join("commands"),
    ];
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".config").join("opencode").join("commands"));
        dirs.push(home.join(".opencode").join("commands"));
    }
    if let Ok(xdg_config_home) = std::env::var("XDG_CONFIG_HOME")
        && !xdg_config_home.trim().is_empty()
    {
        dirs.push(
            PathBuf::from(xdg_config_home)
                .join("opencode")
                .join("commands"),
        );
    }
    dirs
}

fn discover_markdown_commands(
    commands: &mut Vec<SlashCommandDescription>,
    dirs: &[PathBuf],
    fallback_description: &str,
) {
    let mut seen = existing_command_names(commands);
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("md") {
                continue;
            }
            let Some(name) = path.file_stem().and_then(|stem| stem.to_str()) else {
                continue;
            };
            let description =
                read_markdown_description(&path).or_else(|| Some(fallback_description.to_string()));
            add_command_if_missing(
                commands,
                &mut seen,
                name.to_string(),
                description,
                SlashCommandKind::Command,
            );
        }
    }
}

fn discover_skill_commands(
    commands: &mut Vec<SlashCommandDescription>,
    dirs: &[PathBuf],
    fallback_description: &str,
) {
    let mut seen = existing_command_names(commands);
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            let skill_file = path.join("SKILL.md");
            let description = read_markdown_description(&skill_file)
                .or_else(|| Some(fallback_description.to_string()));
            add_command_if_missing(
                commands,
                &mut seen,
                name.to_string(),
                description,
                SlashCommandKind::Skill,
            );
        }
    }
}

fn read_markdown_description(path: &Path) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    for line in content.lines().take(24) {
        let line = line.trim();
        let value = line
            .strip_prefix("description:")
            .or_else(|| line.strip_prefix("Description:"));
        if let Some(value) = value {
            let value = value.trim().trim_matches('"').trim_matches('\'');
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with('#') && *line != "---")
        .map(|line| line.chars().take(160).collect())
}

fn is_slash_command_prompt(prompt: &str) -> bool {
    let trimmed = prompt.trim_start();
    let Some(without_slash) = trimmed.strip_prefix('/') else {
        return false;
    };
    let name = without_slash
        .split_once(char::is_whitespace)
        .map(|(name, _)| name)
        .unwrap_or(without_slash)
        .trim();

    !name.is_empty() && !name.contains('/')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command_names(provider: AcpProvider) -> BTreeSet<String> {
        provider
            .builtin_slash_commands()
            .into_iter()
            .map(|command| command.name)
            .collect()
    }

    #[test]
    fn codex_acp_exposes_chat_visible_commands() {
        let names = command_names(AcpProvider::Codex);

        assert_eq!(names.len(), 4);
        assert!(names.contains("compact"));
        assert!(names.contains("goal"));
        assert!(names.contains("init"));
        assert!(names.contains("review"));
        assert!(!names.contains("mcp"));
    }

    #[test]
    fn claude_acp_exposes_builtin_workflow_commands() {
        let names = command_names(AcpProvider::ClaudeCode);

        assert!(names.contains("review"));
        assert!(names.contains("security-review"));
        assert!(names.contains("context"));
        assert!(names.contains("todos"));
    }

    #[test]
    fn opencode_acp_exposes_builtin_session_commands() {
        let names = command_names(AcpProvider::Opencode);

        assert!(names.contains("commands"));
        assert!(names.contains("sessions"));
        assert!(names.contains("agents"));
        assert!(names.contains("thinking"));
    }

    #[test]
    fn slash_commands_bypass_append_prompt() {
        let executor = AcpBackedExecutor::new(AcpProvider::Codex)
            .with_append_prompt(AppendPrompt(Some("\nextra instruction".to_string())));

        assert_eq!(
            executor.prompt_for_agent("  /compact focus  "),
            "/compact focus"
        );
    }

    #[test]
    fn normal_prompts_keep_append_prompt() {
        let executor = AcpBackedExecutor::new(AcpProvider::Codex)
            .with_append_prompt(AppendPrompt(Some("\nextra instruction".to_string())));

        assert_eq!(
            executor.prompt_for_agent("please inspect this"),
            "please inspect this\nextra instruction"
        );
    }

    #[test]
    fn slash_prefixed_paths_are_not_agent_commands() {
        let executor = AcpBackedExecutor::new(AcpProvider::Codex)
            .with_append_prompt(AppendPrompt(Some("\nextra instruction".to_string())));

        assert_eq!(
            executor.prompt_for_agent("/src/main.rs"),
            "/src/main.rs\nextra instruction"
        );
    }

    #[test]
    fn providers_have_local_acp_command_candidates() {
        assert_eq!(
            AcpProvider::ClaudeCode.local_base_command(),
            (
                local_claude_agent_acp_command(),
                local_claude_agent_acp_command()
            )
        );
        assert_eq!(
            AcpProvider::Codex.local_base_command(),
            (local_codex_acp_command(), local_codex_acp_command())
        );
        assert_eq!(
            AcpProvider::Opencode.local_base_command(),
            (local_opencode_command(), local_opencode_acp_command())
        );
    }

    #[test]
    fn parses_codex_model_context_window_from_config_toml() {
        assert_eq!(
            parse_codex_model_context_window(
                r#"
model = "gpt-5.5"
model_context_window = 1000000
model_auto_compact_token_limit = 900000
"#
            ),
            Some(1_000_000)
        );
        assert_eq!(
            parse_codex_model_context_window("model_context_window = 0"),
            None
        );
        assert_eq!(
            parse_codex_model_context_window("model_context_window = -1"),
            None
        );
    }

    #[tokio::test]
    async fn custom_base_command_bypasses_local_acp_command_selection() {
        let executor = AcpBackedExecutor::new(AcpProvider::ClaudeCode).with_cmd(CmdOverrides {
            base_command_override: Some("custom-acp --serve".to_string()),
            additional_params: None,
            env: None,
        });

        let parts = executor.build_command_parts().await.unwrap();

        assert_eq!(parts.program(), "custom-acp");
        assert_eq!(parts.args(), &["--serve".to_string()]);
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

pub fn codex_config_model_context_window() -> Option<u32> {
    let path = codex_home()?.join("config.toml");
    let content = std::fs::read_to_string(path).ok()?;
    parse_codex_model_context_window(&content)
}

fn parse_codex_model_context_window(content: &str) -> Option<u32> {
    let value = content.parse::<toml::Value>().ok()?;
    value
        .get("model_context_window")
        .and_then(toml::Value::as_integer)
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value > 0)
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

    async fn build_command_parts(&self) -> Result<CommandParts, CommandBuildError> {
        let (local_executable, local_base_command) = self.provider.local_base_command();
        let builder = if self.cmd.base_command_override.is_none()
            && resolve_executable_path(local_executable).await.is_some()
        {
            CommandBuilder::new(local_base_command)
        } else {
            CommandBuilder::new(self.provider.default_base_command())
        };

        apply_overrides(builder, &self.cmd)?.build_initial()
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

    fn prompt_for_agent(&self, prompt: &str) -> String {
        if is_slash_command_prompt(prompt) {
            prompt.trim().to_string()
        } else {
            self.append_prompt.combine_prompt(prompt)
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
        workdir: &std::path::Path,
    ) -> Result<futures::stream::BoxStream<'static, json_patch::Patch>, ExecutorError> {
        let commands = self.provider.slash_commands_for_workdir(workdir);
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
        let command_parts = self.build_command_parts().await?;
        self.harness()
            .spawn_with_command(
                current_dir,
                self.prompt_for_agent(prompt),
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
        let command_parts = self.build_command_parts().await?;
        self.harness()
            .spawn_follow_up_with_command(
                current_dir,
                self.prompt_for_agent(prompt),
                session_id,
                command_parts,
                env,
                &self.cmd,
                self.approvals_for_run(),
            )
            .await
    }

    fn normalize_logs(&self, msg_store: Arc<MsgStore>, worktree_path: &std::path::Path) {
        if self.provider == AcpProvider::Codex {
            normalize_logs_with_context_window_override(
                msg_store,
                worktree_path,
                codex_config_model_context_window(),
            );
        } else {
            normalize_logs(msg_store, worktree_path);
        }
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

fn local_claude_agent_acp_command() -> &'static str {
    if cfg!(windows) {
        "claude-agent-acp.cmd"
    } else {
        "claude-agent-acp"
    }
}

fn local_codex_acp_command() -> &'static str {
    if cfg!(windows) {
        "codex-acp.cmd"
    } else {
        "codex-acp"
    }
}

fn local_opencode_command() -> &'static str {
    if cfg!(windows) {
        "opencode.cmd"
    } else {
        "opencode"
    }
}

fn local_opencode_acp_command() -> &'static str {
    if cfg!(windows) {
        "opencode.cmd acp"
    } else {
        "opencode acp"
    }
}
