use anyhow::Error;
use executors::{executors::AgentKind, profile::ExecutorProfileId};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
pub use v8::{
    EditorConfig, EditorType, GitHubConfig, NotificationConfig, SendMessageShortcut, ShowcaseState,
    SoundFile, ThemeMode, UiLanguage,
};

use crate::services::config::versions::v8;

fn default_git_branch_prefix() -> String {
    "vx".to_string()
}

fn default_pr_auto_description_enabled() -> bool {
    true
}

fn default_commit_reminder_enabled() -> bool {
    true
}

fn default_prompt_enhancement_enabled() -> bool {
    false
}

fn default_prompt_enhancement_model() -> String {
    String::new()
}

fn default_prompt_enhancement_prompt() -> Option<String> {
    None
}

fn default_files_changed_default_collapsed() -> bool {
    true
}

fn default_ai_message_default_collapsed() -> bool {
    true
}

fn default_auto_update_enabled() -> bool {
    true
}

fn default_auto_install_local_dependencies() -> bool {
    true
}

/// How links clicked inside conversation content are opened.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, TS, PartialEq, Eq)]
pub enum LinkOpenBehavior {
    /// Open with the system default browser.
    #[default]
    ExternalBrowser,
    /// Open inside the built-in Web Preview panel.
    BuiltinPreview,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
pub struct Config {
    pub config_version: String,
    pub theme: ThemeMode,
    pub executor_profile: ExecutorProfileId,
    pub disclaimer_acknowledged: bool,
    pub onboarding_acknowledged: bool,
    pub notifications: NotificationConfig,
    pub editor: EditorConfig,
    pub github: GitHubConfig,
    pub workspace_dir: Option<String>,
    pub last_app_version: Option<String>,
    pub show_release_notes: bool,
    #[serde(default)]
    pub language: UiLanguage,
    #[serde(default = "default_git_branch_prefix")]
    pub git_branch_prefix: String,
    #[serde(default)]
    pub showcases: ShowcaseState,
    #[serde(default = "default_pr_auto_description_enabled")]
    pub pr_auto_description_enabled: bool,
    #[serde(default)]
    pub pr_auto_description_prompt: Option<String>,
    #[serde(default)]
    pub beta_workspaces: bool,
    #[serde(default)]
    pub beta_workspaces_invitation_sent: bool,
    #[serde(default = "default_commit_reminder_enabled")]
    pub commit_reminder_enabled: bool,
    #[serde(default)]
    pub commit_reminder_prompt: Option<String>,
    #[serde(default)]
    pub merge_commit_message_template: Option<String>,
    #[serde(default)]
    pub send_message_shortcut: SendMessageShortcut,
    #[serde(default = "default_prompt_enhancement_enabled")]
    pub prompt_enhancement_enabled: bool,
    #[serde(default = "default_prompt_enhancement_model")]
    pub prompt_enhancement_model: String,
    #[serde(default = "default_prompt_enhancement_prompt")]
    pub prompt_enhancement_prompt: Option<String>,
    #[serde(default)]
    pub default_terminal_shell: Option<String>,
    #[serde(default = "default_files_changed_default_collapsed")]
    pub files_changed_default_collapsed: bool,
    #[serde(default = "default_ai_message_default_collapsed")]
    pub ai_message_default_collapsed: bool,
    /// Opt-in entry for connecting a newly created VibeX conversation to an
    /// existing Agent-managed ACP session in the selected workspace.
    #[serde(default)]
    pub previous_session_continuation_enabled: bool,
    /// Agents that have been disabled by the user in settings
    #[serde(default)]
    pub disabled_agents: Vec<AgentKind>,
    /// Custom agent display order (if user has reordered)
    #[serde(default)]
    pub agent_order: Option<Vec<AgentKind>>,
    /// Automatically check for app releases and tool updates on startup.
    #[serde(default = "default_auto_update_enabled")]
    pub auto_update_enabled: bool,
    /// Automatically install or update local dependencies on startup.
    #[serde(default = "default_auto_install_local_dependencies")]
    pub auto_install_local_dependencies: bool,
    /// Opt-in: surface locally captured crash reports on startup so the user
    /// can review the full content and choose to file a GitHub issue.
    /// Capture itself is always local-only; nothing is sent automatically.
    #[serde(default)]
    pub crash_reports_enabled: bool,
    /// How links clicked in conversation content open: system browser or the
    /// built-in Web Preview panel.
    #[serde(default)]
    pub link_open_behavior: LinkOpenBehavior,
}

impl Config {
    fn from_v8_config(old_config: v8::Config) -> Self {
        Self {
            config_version: "v9".to_string(),
            theme: old_config.theme,
            executor_profile: old_config.executor_profile,
            disclaimer_acknowledged: old_config.disclaimer_acknowledged,
            onboarding_acknowledged: old_config.onboarding_acknowledged,
            notifications: old_config.notifications,
            editor: old_config.editor,
            github: old_config.github,
            workspace_dir: old_config.workspace_dir,
            last_app_version: old_config.last_app_version,
            show_release_notes: old_config.show_release_notes,
            language: old_config.language,
            git_branch_prefix: old_config.git_branch_prefix,
            showcases: old_config.showcases,
            pr_auto_description_enabled: old_config.pr_auto_description_enabled,
            pr_auto_description_prompt: old_config.pr_auto_description_prompt,
            beta_workspaces: old_config.beta_workspaces,
            beta_workspaces_invitation_sent: old_config.beta_workspaces_invitation_sent,
            commit_reminder_enabled: old_config.commit_reminder_enabled,
            commit_reminder_prompt: old_config.commit_reminder_prompt,
            merge_commit_message_template: old_config.merge_commit_message_template,
            send_message_shortcut: old_config.send_message_shortcut,
            prompt_enhancement_enabled: default_prompt_enhancement_enabled(),
            prompt_enhancement_model: default_prompt_enhancement_model(),
            prompt_enhancement_prompt: default_prompt_enhancement_prompt(),
            default_terminal_shell: None,
            files_changed_default_collapsed: default_files_changed_default_collapsed(),
            ai_message_default_collapsed: default_ai_message_default_collapsed(),
            previous_session_continuation_enabled: false,
            disabled_agents: Vec::new(),
            agent_order: None,
            auto_update_enabled: default_auto_update_enabled(),
            auto_install_local_dependencies: default_auto_install_local_dependencies(),
            crash_reports_enabled: false,
            link_open_behavior: LinkOpenBehavior::default(),
        }
    }

    pub fn from_previous_version(raw_config: &str) -> Result<Self, Error> {
        let old_config = v8::Config::from(raw_config.to_string());
        Ok(Self::from_v8_config(old_config))
    }
}

impl From<String> for Config {
    fn from(raw_config: String) -> Self {
        if let Ok(config) = serde_json::from_str::<Config>(&raw_config)
            && config.config_version == "v9"
        {
            return config;
        }

        match Self::from_previous_version(&raw_config) {
            Ok(config) => {
                tracing::info!("Config upgraded to v9");
                config
            }
            Err(e) => {
                tracing::warn!("Config migration failed: {}, using default", e);
                Self::default()
            }
        }
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            config_version: "v9".to_string(),
            theme: ThemeMode::System,
            executor_profile: ExecutorProfileId::new(AgentKind::ClaudeCode),
            disclaimer_acknowledged: false,
            onboarding_acknowledged: false,
            notifications: NotificationConfig::default(),
            editor: EditorConfig::default(),
            github: GitHubConfig::default(),
            workspace_dir: None,
            last_app_version: None,
            show_release_notes: false,
            language: UiLanguage::default(),
            git_branch_prefix: default_git_branch_prefix(),
            showcases: ShowcaseState::default(),
            pr_auto_description_enabled: true,
            pr_auto_description_prompt: None,
            beta_workspaces: false,
            beta_workspaces_invitation_sent: false,
            commit_reminder_enabled: true,
            commit_reminder_prompt: None,
            merge_commit_message_template: None,
            send_message_shortcut: SendMessageShortcut::default(),
            prompt_enhancement_enabled: default_prompt_enhancement_enabled(),
            prompt_enhancement_model: default_prompt_enhancement_model(),
            prompt_enhancement_prompt: default_prompt_enhancement_prompt(),
            default_terminal_shell: None,
            files_changed_default_collapsed: default_files_changed_default_collapsed(),
            ai_message_default_collapsed: default_ai_message_default_collapsed(),
            previous_session_continuation_enabled: false,
            disabled_agents: Vec::new(),
            agent_order: None,
            auto_update_enabled: default_auto_update_enabled(),
            auto_install_local_dependencies: default_auto_install_local_dependencies(),
            crash_reports_enabled: false,
            link_open_behavior: LinkOpenBehavior::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Config;

    #[test]
    fn conversation_content_defaults_to_collapsed() {
        let config = Config::default();

        assert!(config.files_changed_default_collapsed);
        assert!(config.ai_message_default_collapsed);
    }

    #[test]
    fn missing_conversation_collapse_preferences_use_enabled_defaults() {
        let mut saved = serde_json::to_value(Config::default()).expect("serialize config");
        let saved_object = saved.as_object_mut().expect("config object");
        saved_object.remove("files_changed_default_collapsed");
        saved_object.remove("ai_message_default_collapsed");

        let loaded: Config = serde_json::from_value(saved).expect("load older v9 config");

        assert!(loaded.files_changed_default_collapsed);
        assert!(loaded.ai_message_default_collapsed);
    }

    #[test]
    fn previous_session_continuation_remains_off_when_absent_from_saved_config() {
        let mut saved = serde_json::to_value(Config::default()).expect("serialize config");
        saved
            .as_object_mut()
            .expect("config object")
            .remove("previous_session_continuation_enabled");

        let loaded: Config = serde_json::from_value(saved).expect("load older v9 config");

        assert!(!loaded.previous_session_continuation_enabled);
    }
}
