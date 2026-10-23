use anyhow::Error;
use executors::{executors::AgentKind, profile::ExecutorProfileId};
use serde::{Deserialize, Serialize};
use ts_rs::TS;
pub use v8::{
    EditorConfig, EditorType, GitHubConfig, NotificationConfig, SendMessageShortcut, SoundFile,
    ThemeMode, UiLanguage,
};

pub use super::v2::NotificationWhen;
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

fn default_commit_reminder_line_threshold() -> u32 {
    10_000
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

fn default_hide_model_thinking() -> bool {
    false
}

fn default_auto_update_enabled() -> bool {
    true
}

fn default_multi_agent_depth_limit() -> u32 {
    1
}

fn default_multi_agent_completed_cache_max_mb() -> u64 {
    512
}

fn default_multi_agent_conversation_list_default_days() -> u32 {
    7
}

fn default_multi_agent_delay_max_hours() -> u32 {
    24
}

/// Session options applied only when `delegate_to_agent` starts a child.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct MultiAgentAgentDefault {
    #[serde(default, alias = "modeId", skip_serializing_if = "Option::is_none")]
    pub mode_id: Option<String>,
    #[serde(
        default,
        alias = "configValues",
        skip_serializing_if = "std::collections::BTreeMap::is_empty"
    )]
    pub config_values: std::collections::BTreeMap<String, String>,
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

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CommitReminderMode {
    SeparateTurn,
    #[default]
    Smart,
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
    #[serde(default = "default_pr_auto_description_enabled")]
    pub pr_auto_description_enabled: bool,
    #[serde(default)]
    pub pr_auto_description_prompt: Option<String>,
    #[serde(default)]
    pub pr_auto_description_agent_id: String,
    #[serde(default)]
    pub pr_auto_description_mode: Option<String>,
    #[serde(default)]
    pub pr_auto_description_session_config: std::collections::BTreeMap<String, String>,
    #[serde(default = "default_commit_reminder_enabled")]
    pub commit_reminder_enabled: bool,
    #[serde(default)]
    pub commit_reminder_mode: CommitReminderMode,
    #[serde(default = "default_commit_reminder_line_threshold")]
    pub commit_reminder_line_threshold: u32,
    #[serde(default)]
    pub send_message_shortcut: SendMessageShortcut,
    #[serde(default = "default_prompt_enhancement_enabled")]
    pub prompt_enhancement_enabled: bool,
    #[serde(default = "default_prompt_enhancement_model")]
    pub prompt_enhancement_model: String,
    #[serde(default)]
    pub prompt_enhancement_agent_id: String,
    #[serde(default)]
    pub prompt_enhancement_mode: Option<String>,
    #[serde(default)]
    pub prompt_enhancement_session_config: std::collections::BTreeMap<String, String>,
    #[serde(default = "default_prompt_enhancement_prompt")]
    pub prompt_enhancement_prompt: Option<String>,
    /// Opt-in: show the compact-context action in the session input box.
    #[serde(default)]
    pub compact_context_enabled: bool,
    #[serde(default)]
    pub default_terminal_shell: Option<String>,
    #[serde(default = "default_files_changed_default_collapsed")]
    pub files_changed_default_collapsed: bool,
    #[serde(default = "default_ai_message_default_collapsed")]
    pub ai_message_default_collapsed: bool,
    /// Hide model thinking / reasoning blocks in conversation transcripts.
    #[serde(default = "default_hide_model_thinking")]
    pub hide_model_thinking: bool,
    /// Opt-in entry for connecting a newly created VibeX conversation to an
    /// existing Agent-managed ACP session in the selected workspace.
    #[serde(default)]
    pub previous_session_continuation_enabled: bool,
    /// Automatically check for app releases on startup.
    #[serde(default = "default_auto_update_enabled")]
    pub auto_update_enabled: bool,
    /// Opt-in: surface locally captured crash reports on startup so the user
    /// can review the full content and choose to file a GitHub issue.
    /// Capture itself is always local-only; nothing is sent automatically.
    #[serde(default)]
    pub crash_reports_enabled: bool,
    /// How links clicked in conversation content open: system browser or the
    /// built-in Web Preview panel.
    #[serde(default)]
    pub link_open_behavior: LinkOpenBehavior,
    /// Host MultiAgent collaboration. Default off. Only new sessions pick up
    /// the MCP tools and skill.
    #[serde(default)]
    pub multi_agent_enabled: bool,
    #[serde(default = "default_multi_agent_depth_limit")]
    pub multi_agent_depth_limit: u32,
    #[serde(default = "default_multi_agent_completed_cache_max_mb")]
    #[ts(type = "number")]
    pub multi_agent_completed_cache_max_mb: u64,
    #[serde(default = "default_multi_agent_conversation_list_default_days")]
    pub multi_agent_conversation_list_default_days: u32,
    #[serde(default = "default_multi_agent_delay_max_hours")]
    pub multi_agent_delay_max_hours: u32,
    #[serde(default)]
    pub multi_agent_agent_defaults: std::collections::BTreeMap<String, MultiAgentAgentDefault>,
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
            pr_auto_description_enabled: old_config.pr_auto_description_enabled,
            pr_auto_description_prompt: old_config.pr_auto_description_prompt,
            pr_auto_description_agent_id: String::new(),
            pr_auto_description_mode: None,
            pr_auto_description_session_config: std::collections::BTreeMap::new(),
            commit_reminder_enabled: old_config.commit_reminder_enabled,
            commit_reminder_mode: CommitReminderMode::default(),
            commit_reminder_line_threshold: default_commit_reminder_line_threshold(),
            send_message_shortcut: old_config.send_message_shortcut,
            prompt_enhancement_enabled: default_prompt_enhancement_enabled(),
            prompt_enhancement_model: default_prompt_enhancement_model(),
            prompt_enhancement_agent_id: String::new(),
            prompt_enhancement_mode: None,
            prompt_enhancement_session_config: std::collections::BTreeMap::new(),
            prompt_enhancement_prompt: default_prompt_enhancement_prompt(),
            compact_context_enabled: false,
            default_terminal_shell: None,
            files_changed_default_collapsed: default_files_changed_default_collapsed(),
            ai_message_default_collapsed: default_ai_message_default_collapsed(),
            hide_model_thinking: default_hide_model_thinking(),
            previous_session_continuation_enabled: false,
            auto_update_enabled: default_auto_update_enabled(),
            crash_reports_enabled: false,
            link_open_behavior: LinkOpenBehavior::default(),
            multi_agent_enabled: false,
            multi_agent_depth_limit: default_multi_agent_depth_limit(),
            multi_agent_completed_cache_max_mb: default_multi_agent_completed_cache_max_mb(),
            multi_agent_conversation_list_default_days:
                default_multi_agent_conversation_list_default_days(),
            multi_agent_delay_max_hours: default_multi_agent_delay_max_hours(),
            multi_agent_agent_defaults: std::collections::BTreeMap::new(),
        }
    }

    pub fn clamp_multi_agent(&mut self) {
        self.multi_agent_depth_limit = self.multi_agent_depth_limit.clamp(1, 8);
        self.multi_agent_completed_cache_max_mb =
            self.multi_agent_completed_cache_max_mb.min(1_000_000);
        self.multi_agent_conversation_list_default_days =
            self.multi_agent_conversation_list_default_days.clamp(1, 90);
        self.multi_agent_delay_max_hours = self.multi_agent_delay_max_hours.clamp(1, 168);
        self.multi_agent_agent_defaults.retain(|_, defaults| {
            defaults
                .mode_id
                .as_ref()
                .is_some_and(|mode| !mode.is_empty())
                || !defaults.config_values.is_empty()
        });
    }

    pub fn from_previous_version(raw_config: &str) -> Result<Self, Error> {
        let old_config = v8::Config::from(raw_config.to_string());
        Ok(Self::from_v8_config(old_config))
    }
}

impl From<String> for Config {
    fn from(raw_config: String) -> Self {
        if let Ok(mut config) = serde_json::from_str::<Config>(&raw_config)
            && config.config_version == "v9"
        {
            config.clamp_multi_agent();
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
            pr_auto_description_enabled: true,
            pr_auto_description_prompt: None,
            pr_auto_description_agent_id: String::new(),
            pr_auto_description_mode: None,
            pr_auto_description_session_config: std::collections::BTreeMap::new(),
            commit_reminder_enabled: true,
            commit_reminder_mode: CommitReminderMode::default(),
            commit_reminder_line_threshold: default_commit_reminder_line_threshold(),
            send_message_shortcut: SendMessageShortcut::default(),
            prompt_enhancement_enabled: default_prompt_enhancement_enabled(),
            prompt_enhancement_model: default_prompt_enhancement_model(),
            prompt_enhancement_agent_id: String::new(),
            prompt_enhancement_mode: None,
            prompt_enhancement_session_config: std::collections::BTreeMap::new(),
            prompt_enhancement_prompt: default_prompt_enhancement_prompt(),
            compact_context_enabled: false,
            default_terminal_shell: None,
            files_changed_default_collapsed: default_files_changed_default_collapsed(),
            ai_message_default_collapsed: default_ai_message_default_collapsed(),
            hide_model_thinking: default_hide_model_thinking(),
            previous_session_continuation_enabled: false,
            auto_update_enabled: default_auto_update_enabled(),
            crash_reports_enabled: false,
            link_open_behavior: LinkOpenBehavior::default(),
            multi_agent_enabled: false,
            multi_agent_depth_limit: default_multi_agent_depth_limit(),
            multi_agent_completed_cache_max_mb: default_multi_agent_completed_cache_max_mb(),
            multi_agent_conversation_list_default_days:
                default_multi_agent_conversation_list_default_days(),
            multi_agent_delay_max_hours: default_multi_agent_delay_max_hours(),
            multi_agent_agent_defaults: std::collections::BTreeMap::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{CommitReminderMode, Config};

    #[test]
    fn commit_reminders_default_to_a_ten_thousand_line_smart_mode() {
        let config = Config::default();

        assert_eq!(config.commit_reminder_mode, CommitReminderMode::Smart);
        assert_eq!(config.commit_reminder_line_threshold, 10_000);
    }

    #[test]
    fn older_v9_configs_receive_prompt_enhancement_agent_and_notify_when() {
        let mut saved = serde_json::to_value(Config::default()).expect("serialize config");
        let saved = saved.as_object_mut().expect("config object");
        saved.remove("prompt_enhancement_agent_id");
        saved.remove("prompt_enhancement_mode");
        saved.remove("prompt_enhancement_session_config");
        if let Some(notifications) = saved
            .get_mut("notifications")
            .and_then(|value| value.as_object_mut())
        {
            notifications.remove("notify_when");
        }

        let loaded: Config =
            serde_json::from_value(serde_json::Value::Object(saved.clone())).expect("load config");

        assert!(loaded.prompt_enhancement_agent_id.is_empty());
        assert!(loaded.prompt_enhancement_mode.is_none());
        assert!(loaded.prompt_enhancement_session_config.is_empty());
        assert_eq!(
            loaded.notifications.notify_when,
            super::NotificationWhen::Unfocused
        );
    }

    #[test]
    fn older_v9_configs_receive_commit_reminder_defaults() {
        let mut saved = serde_json::to_value(Config::default()).expect("serialize config");
        let saved = saved.as_object_mut().expect("config object");
        saved.remove("commit_reminder_mode");
        saved.remove("commit_reminder_line_threshold");

        let loaded: Config =
            serde_json::from_value(serde_json::Value::Object(saved.clone())).expect("load config");

        assert_eq!(loaded.commit_reminder_mode, CommitReminderMode::Smart);
        assert_eq!(loaded.commit_reminder_line_threshold, 10_000);
    }

    #[test]
    fn conversation_content_defaults_to_collapsed_with_visible_thinking() {
        let config = Config::default();

        assert!(config.files_changed_default_collapsed);
        assert!(config.ai_message_default_collapsed);
        assert!(!config.hide_model_thinking);
    }

    #[test]
    fn missing_conversation_preferences_keep_thinking_visible() {
        let mut saved = serde_json::to_value(Config::default()).expect("serialize config");
        let saved_object = saved.as_object_mut().expect("config object");
        saved_object.remove("files_changed_default_collapsed");
        saved_object.remove("ai_message_default_collapsed");
        saved_object.remove("hide_model_thinking");

        let loaded: Config = serde_json::from_value(saved).expect("load older v9 config");

        assert!(loaded.files_changed_default_collapsed);
        assert!(loaded.ai_message_default_collapsed);
        assert!(!loaded.hide_model_thinking);
    }

    #[test]
    fn compact_context_remains_off_by_default_and_when_absent_from_saved_config() {
        assert!(!Config::default().compact_context_enabled);

        let mut saved = serde_json::to_value(Config::default()).expect("serialize config");
        saved
            .as_object_mut()
            .expect("config object")
            .remove("compact_context_enabled");

        let loaded: Config = serde_json::from_value(saved).expect("load older v9 config");

        assert!(!loaded.compact_context_enabled);
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

    #[test]
    fn older_v9_configs_receive_pr_description_agent_defaults() {
        let mut saved = serde_json::to_value(Config::default()).expect("serialize config");
        let saved = saved.as_object_mut().expect("config object");
        saved.remove("pr_auto_description_agent_id");
        saved.remove("pr_auto_description_mode");
        saved.remove("pr_auto_description_session_config");

        let loaded: Config =
            serde_json::from_value(serde_json::Value::Object(saved.clone())).expect("load config");

        assert!(loaded.pr_auto_description_agent_id.is_empty());
        assert!(loaded.pr_auto_description_mode.is_none());
        assert!(loaded.pr_auto_description_session_config.is_empty());
    }

    #[test]
    fn multi_agent_stays_off_and_clamps_scalars() {
        let config = Config::default();
        assert!(!config.multi_agent_enabled);
        assert_eq!(config.multi_agent_depth_limit, 1);
        assert_eq!(config.multi_agent_completed_cache_max_mb, 512);
        assert_eq!(config.multi_agent_conversation_list_default_days, 7);
        assert_eq!(config.multi_agent_delay_max_hours, 24);

        let mut saved = serde_json::to_value(Config::default()).expect("serialize");
        saved
            .as_object_mut()
            .expect("object")
            .remove("multi_agent_enabled");
        let loaded: Config = serde_json::from_value(saved).expect("load");
        assert!(!loaded.multi_agent_enabled);
        assert_eq!(loaded.multi_agent_depth_limit, 1);

        let mut wide = Config {
            multi_agent_depth_limit: 99,
            multi_agent_completed_cache_max_mb: 2_000_000,
            multi_agent_conversation_list_default_days: 0,
            multi_agent_delay_max_hours: 999,
            ..Default::default()
        };
        wide.clamp_multi_agent();
        assert_eq!(wide.multi_agent_depth_limit, 8);
        assert_eq!(wide.multi_agent_completed_cache_max_mb, 1_000_000);
        assert_eq!(wide.multi_agent_conversation_list_default_days, 1);
        assert_eq!(wide.multi_agent_delay_max_hours, 168);
    }
}
