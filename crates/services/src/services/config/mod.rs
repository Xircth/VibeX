use std::path::Path;

use thiserror::Error;

use crate::services::settings_store::{read_section, write_section};

const APPLICATION_SETTINGS_SECTION: &str = "application";

pub mod editor;
mod versions;

pub use editor::EditorOpenError;

pub const DEFAULT_PR_DESCRIPTION_PROMPT: &str = r#"You write pull request titles and descriptions.

Rules:
1. Be accurate: use only the provided git context and task context.
2. Output JSON only, with exactly two top-level fields named Title and Body.
3. Title is concise, descriptive, and ends with " (VibeX)".
4. Body explains what changed, why, and important implementation details.
5. End the body with: "This PR was written using [VibeX](https://vibex.com)"
6. Do not return Markdown fences, commentary, or extra fields.

Output shape:
{"Title":"...","Body":"..."}"#;

pub const COMMIT_CHANGES_INSTRUCTION_ID: &str = "commit_changes";
pub const COMMIT_CHANGES_INSTRUCTION_COMMAND: &str = "#commit_changes";
pub const COMMIT_CHANGES_INSTRUCTION_DESCRIPTION: &str =
    "检查未提交更改，并在验证后创建规范的 Git 提交。";
pub const COMMIT_CHANGES_INSTRUCTION_CONTENT: &str = r#"There are uncommitted changes. Please review the diff with `git diff` and `git diff --staged`, then stage and commit them.

Generate a commit message following this format:
- First line: a short header under 50 characters in the format `<type>(<scope>): <subject>`
  - Use types: feat (features), fix (bug fixes), docs (documentation), style (formatting), refactor (restructuring), perf (performance), test (tests), chore (maintenance), revert (rollbacks)
  - Include scope to specify the affected area
- Second line: blank
- Third line onwards: a full summary explaining the change in detail, including the problem, solution, and context, wrapping lines at 72 characters

Base the commit message on the actual code changes shown in the diff."#;

pub const DEFAULT_MERGE_COMMIT_MESSAGE_TEMPLATE: &str = "{title} (VibeX {id})\n\n{description}";

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("Validation error: {0}")]
    ValidationError(String),
}

pub type Config = versions::v9::Config;
pub type NotificationConfig = versions::v9::NotificationConfig;
pub type EditorConfig = versions::v9::EditorConfig;
pub type ThemeMode = versions::v9::ThemeMode;
pub type SoundFile = versions::v9::SoundFile;
pub type EditorType = versions::v9::EditorType;
pub type GitHubConfig = versions::v9::GitHubConfig;
pub type UiLanguage = versions::v9::UiLanguage;
pub type SendMessageShortcut = versions::v9::SendMessageShortcut;
pub type LinkOpenBehavior = versions::v9::LinkOpenBehavior;
pub type CommitReminderMode = versions::v9::CommitReminderMode;
pub type NotificationWhen = versions::v9::NotificationWhen;

/// Will always return config, trying old schemas or eventually returning default
pub async fn load_config_from_file(config_path: &Path) -> Config {
    match read_section::<serde_json::Value>(config_path, APPLICATION_SETTINGS_SECTION).await {
        Ok(Some(raw_config)) => Config::from(raw_config.to_string()),
        Ok(None) => match std::fs::read_to_string(config_path) {
            // Backward compatibility for the former standalone config.json.
            Ok(raw_config) => Config::from(raw_config),
            Err(_) => {
                tracing::info!("No settings file found, creating one");
                Config::default()
            }
        },
        Err(error) => {
            tracing::warn!(%error, "Failed to read application settings; using defaults");
            Config::default()
        }
    }
}

/// Saves the config to the given path
pub async fn save_config_to_file(config: &Config, config_path: &Path) -> Result<(), ConfigError> {
    write_section(config_path, APPLICATION_SETTINGS_SECTION, config)
        .await
        .map_err(|error| match error {
            crate::services::settings_store::SettingsStoreError::Io(error) => {
                ConfigError::Io(error)
            }
            crate::services::settings_store::SettingsStoreError::Json(error) => {
                ConfigError::Json(error)
            }
            crate::services::settings_store::SettingsStoreError::InvalidDocument => {
                ConfigError::ValidationError("Settings document must be a JSON object".to_string())
            }
        })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{Config, load_config_from_file, save_config_to_file};

    #[tokio::test]
    async fn application_config_roundtrips_inside_the_unified_settings_document() {
        let temp = tempfile::tempdir().expect("temp dir");
        let path = temp.path().join("settings.json");
        tokio::fs::write(
            &path,
            r#"{"worktrees":{"project-a":{"cleanup_prompt_enabled":true}}}"#,
        )
        .await
        .expect("seed settings");
        let config = Config {
            workspace_dir: Some("~/Worktrees".to_string()),
            ..Config::default()
        };

        save_config_to_file(&config, &path)
            .await
            .expect("save application settings");
        let loaded = load_config_from_file(&path).await;
        assert_eq!(loaded.workspace_dir.as_deref(), Some("~/Worktrees"));

        let document: serde_json::Value = serde_json::from_str(
            &tokio::fs::read_to_string(&path)
                .await
                .expect("read settings"),
        )
        .expect("valid JSON");
        assert_eq!(
            document["worktrees"]["project-a"]["cleanup_prompt_enabled"],
            true
        );
        assert_eq!(document["application"]["workspace_dir"], "~/Worktrees");
    }
}
