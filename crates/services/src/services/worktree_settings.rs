use std::{collections::BTreeMap, path::Path};

use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::services::settings_store::{SettingsStoreError, merge_object_section, read_section};

const SETTINGS_SECTION: &str = "worktrees";

#[derive(Debug, Error)]
pub enum WorktreeSettingsError {
    #[error(transparent)]
    Store(#[from] SettingsStoreError),
    #[error("Failed to run worktree lifecycle command in {path}: {source}")]
    CommandIo {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("Worktree lifecycle command failed in {path}: {detail}")]
    CommandFailed { path: String, detail: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectWorktreeSettings {
    pub create_command: Option<String>,
    pub delete_command: Option<String>,
    pub cleanup_prompt_enabled: bool,
    pub cleanup_prompt_threshold: u32,
}

impl Default for ProjectWorktreeSettings {
    fn default() -> Self {
        Self {
            create_command: None,
            delete_command: None,
            cleanup_prompt_enabled: false,
            cleanup_prompt_threshold: 5,
        }
    }
}

pub fn normalize_settings(settings: ProjectWorktreeSettings) -> ProjectWorktreeSettings {
    fn normalize_command(command: Option<String>) -> Option<String> {
        command
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    }

    ProjectWorktreeSettings {
        create_command: normalize_command(settings.create_command),
        delete_command: normalize_command(settings.delete_command),
        cleanup_prompt_enabled: settings.cleanup_prompt_enabled,
        cleanup_prompt_threshold: settings.cleanup_prompt_threshold.max(1),
    }
}

pub fn should_prompt_cleanup(settings: &ProjectWorktreeSettings, current_count: usize) -> bool {
    settings.cleanup_prompt_enabled
        && current_count >= settings.cleanup_prompt_threshold.max(1) as usize
}

type WorktreeSettingsMap = BTreeMap<String, ProjectWorktreeSettings>;

async fn load_settings_map(
    settings_path: &Path,
) -> Result<WorktreeSettingsMap, WorktreeSettingsError> {
    Ok(read_section(settings_path, SETTINGS_SECTION)
        .await?
        .unwrap_or_default())
}

pub async fn load_project_settings(
    settings_path: &Path,
    project_id: Uuid,
) -> Result<ProjectWorktreeSettings, WorktreeSettingsError> {
    Ok(load_settings_map(settings_path)
        .await?
        .remove(&project_id.to_string())
        .map(normalize_settings)
        .unwrap_or_default())
}

pub async fn save_project_settings(
    settings_path: &Path,
    project_id: Uuid,
    settings: ProjectWorktreeSettings,
) -> Result<ProjectWorktreeSettings, WorktreeSettingsError> {
    let settings = normalize_settings(settings);
    merge_object_section(
        settings_path,
        SETTINGS_SECTION,
        serde_json::Map::from_iter([(
            project_id.to_string(),
            serde_json::to_value(&settings).map_err(SettingsStoreError::from)?,
        )]),
    )
    .await?;
    Ok(settings)
}

#[derive(Clone, Copy)]
enum Lifecycle {
    Create,
    Delete,
}

pub async fn run_project_worktree_create_command(
    settings_path: &Path,
    project_id: Uuid,
    workspace_id: Uuid,
    working_dir: &Path,
) -> Result<(), WorktreeSettingsError> {
    run_lifecycle_command(
        settings_path,
        project_id,
        workspace_id,
        working_dir,
        Lifecycle::Create,
    )
    .await
}

pub async fn run_project_worktree_delete_command(
    settings_path: &Path,
    project_id: Uuid,
    workspace_id: Uuid,
    working_dir: &Path,
) -> Result<(), WorktreeSettingsError> {
    run_lifecycle_command(
        settings_path,
        project_id,
        workspace_id,
        working_dir,
        Lifecycle::Delete,
    )
    .await
}

async fn run_lifecycle_command(
    settings_path: &Path,
    project_id: Uuid,
    workspace_id: Uuid,
    working_dir: &Path,
    lifecycle: Lifecycle,
) -> Result<(), WorktreeSettingsError> {
    let settings = load_project_settings(settings_path, project_id).await?;
    let command = match lifecycle {
        Lifecycle::Create => settings.create_command,
        Lifecycle::Delete => settings.delete_command,
    };
    let Some(command) = command else {
        return Ok(());
    };

    execute_lifecycle_command(&command, project_id, workspace_id, working_dir).await
}

async fn execute_lifecycle_command(
    command: &str,
    project_id: Uuid,
    workspace_id: Uuid,
    working_dir: &Path,
) -> Result<(), WorktreeSettingsError> {
    let (program, args): (&str, Vec<&str>) = if cfg!(target_os = "windows") {
        ("cmd", vec!["/C", command])
    } else {
        ("sh", vec!["-lc", command])
    };
    let mut process = utils::process::new_hidden_tokio_command(program, args);
    process
        .current_dir(working_dir)
        .env("VIBEX_PROJECT_ID", project_id.to_string())
        .env("VIBEX_WORKSPACE_ID", workspace_id.to_string())
        .env("VIBEX_WORKTREE_PATH", working_dir)
        .kill_on_drop(true);
    let output = process
        .output()
        .await
        .map_err(|source| WorktreeSettingsError::CommandIo {
            path: working_dir.display().to_string(),
            source,
        })?;
    if output.status.success() {
        return Ok(());
    }

    let detail = utils::process::command_output_detail(&output)
        .unwrap_or_else(|| format!("process exited with status {}", output.status));
    Err(WorktreeSettingsError::CommandFailed {
        path: working_dir.display().to_string(),
        detail,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        ProjectWorktreeSettings, execute_lifecycle_command, normalize_settings,
        should_prompt_cleanup,
    };

    #[test]
    fn cleanup_prompt_appears_only_when_the_next_worktree_exceeds_the_limit() {
        let settings = ProjectWorktreeSettings {
            cleanup_prompt_enabled: true,
            cleanup_prompt_threshold: 3,
            ..ProjectWorktreeSettings::default()
        };

        assert!(!should_prompt_cleanup(&settings, 2));
        assert!(should_prompt_cleanup(&settings, 3));
    }

    #[test]
    fn cleanup_prompt_is_disabled_by_default() {
        assert!(!should_prompt_cleanup(
            &ProjectWorktreeSettings::default(),
            99
        ));
    }

    #[test]
    fn blank_lifecycle_commands_are_not_persisted_as_commands() {
        let settings = normalize_settings(ProjectWorktreeSettings {
            create_command: Some("  \n".to_string()),
            delete_command: Some(" pnpm install ".to_string()),
            ..ProjectWorktreeSettings::default()
        });

        assert_eq!(settings.create_command, None);
        assert_eq!(settings.delete_command.as_deref(), Some("pnpm install"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn lifecycle_command_receives_worktree_context() {
        let temp = tempfile::tempdir().expect("temp dir");
        let project_id = uuid::Uuid::new_v4();
        let workspace_id = uuid::Uuid::new_v4();

        execute_lifecycle_command(
            r#"printf '%s|%s|%s' "$VIBEX_PROJECT_ID" "$VIBEX_WORKSPACE_ID" "$VIBEX_WORKTREE_PATH" > lifecycle.txt"#,
            project_id,
            workspace_id,
            temp.path(),
        )
        .await
        .expect("run lifecycle command");

        let output = std::fs::read_to_string(temp.path().join("lifecycle.txt"))
            .expect("read command output");
        assert_eq!(
            output,
            format!(
                "{project_id}|{workspace_id}|{}",
                temp.path().to_string_lossy()
            )
        );
    }
}
