use std::{collections::BTreeMap, path::Path};

use db::models::repo::Repo;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::services::settings_store::{SettingsStoreError, merge_object_section, read_section};

const SETTINGS_SECTION: &str = "worktrees";

#[derive(Debug, Error)]
pub enum WorktreeSettingsError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Workspace(#[from] super::workspace_manager::WorkspaceError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
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
        cleanup_prompt_threshold: settings.cleanup_prompt_threshold.clamp(1, 999),
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

pub async fn run_project_workspace_create_command(
    settings_path: &Path,
    project_id: Uuid,
    workspace_id: Uuid,
    workspace_dir: &Path,
    repos: &[Repo],
) -> Result<(), WorktreeSettingsError> {
    run_repository_commands(
        settings_path,
        project_id,
        workspace_id,
        workspace_dir,
        repos,
        Lifecycle::Create,
    )
    .await
}

pub async fn run_project_workspace_delete_command(
    settings_path: &Path,
    project_id: Uuid,
    workspace_id: Uuid,
    workspace_dir: &Path,
    repos: &[Repo],
) -> Result<(), WorktreeSettingsError> {
    let journal = workspace_dir.join(".vibex-deletion.json");
    let mut completed: Vec<Uuid> = read_section(&journal, "completed_repos")
        .await?
        .unwrap_or_default();
    for repo in repos {
        if completed.contains(&repo.id) {
            continue;
        }
        run_repository_commands(
            settings_path,
            project_id,
            workspace_id,
            workspace_dir,
            std::slice::from_ref(repo),
            Lifecycle::Delete,
        )
        .await?;
        completed.push(repo.id);
        crate::services::settings_store::write_section(&journal, "completed_repos", &completed)
            .await?;
    }
    Ok(())
}

async fn run_repository_commands(
    settings_path: &Path,
    project_id: Uuid,
    workspace_id: Uuid,
    workspace_dir: &Path,
    repos: &[Repo],
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
    for repo in repos {
        let repo_dir = if workspace_dir.join(".git").is_file() {
            workspace_dir.to_path_buf()
        } else {
            workspace_dir.join(&repo.name)
        };
        // Deletion can resume after an earlier attempt removed some worktrees.
        if !repo_dir.exists() && matches!(lifecycle, Lifecycle::Delete) {
            continue;
        }
        let working_dir = repo
            .default_working_dir
            .as_ref()
            .map(|dir| repo_dir.join(dir))
            .unwrap_or_else(|| repo_dir.clone());
        let canonical_repo = tokio::fs::canonicalize(&repo_dir).await?;
        let canonical_cwd = tokio::fs::canonicalize(&working_dir).await?;
        if !canonical_cwd.starts_with(&canonical_repo) {
            return Err(WorktreeSettingsError::CommandFailed {
                path: working_dir.display().to_string(),
                detail: "Working directory must be inside its repository".into(),
            });
        }
        execute_repository_command(
            &command,
            RepositoryCommand {
                project_id,
                workspace_id,
                working_dir: &working_dir,
                workspace_dir,
                repo_dir: &repo_dir,
                repo,
                lifecycle,
            },
        )
        .await?;
    }
    Ok(())
}

struct RepositoryCommand<'a> {
    project_id: Uuid,
    workspace_id: Uuid,
    working_dir: &'a Path,
    workspace_dir: &'a Path,
    repo_dir: &'a Path,
    repo: &'a Repo,
    lifecycle: Lifecycle,
}

async fn execute_repository_command(
    command: &str,
    context: RepositoryCommand<'_>,
) -> Result<(), WorktreeSettingsError> {
    use command_group::AsyncCommandGroup;
    let RepositoryCommand {
        project_id,
        workspace_id,
        working_dir,
        workspace_dir,
        repo_dir,
        repo,
        lifecycle,
    } = context;
    let phase = match lifecycle {
        Lifecycle::Create => "create",
        Lifecycle::Delete => "delete",
    };
    let log_path = workspace_dir.join(format!(".vibex-{phase}-{}.log", repo.id));
    let log = std::fs::File::create(&log_path)?;
    let mut process = lifecycle_process(command, project_id, workspace_id, working_dir);
    process
        .env("VIBEX_WORKSPACE_PATH", workspace_dir)
        .env("VIBEX_WORKTREE_PATH", repo_dir)
        .env("VIBEX_REPO_PATH", repo_dir)
        .env("VIBEX_SOURCE_REPO_PATH", &repo.path)
        .stdout(log.try_clone()?)
        .stderr(log);
    let mut child = process
        .group()
        .kill_on_drop(true)
        .spawn()
        .map_err(|source| WorktreeSettingsError::CommandIo {
            path: working_dir.display().to_string(),
            source,
        })?;
    let cancellation = super::workspace_lifecycle::initialization_cancellation(workspace_id);
    let result = tokio::select! {
        result = tokio::time::timeout(std::time::Duration::from_secs(600), child.wait()) => Some(result),
        _ = cancellation.cancelled(), if matches!(lifecycle, Lifecycle::Create) => None,
    };
    let detail = match result {
        Some(Ok(Ok(status))) if status.success() => return Ok(()),
        Some(Ok(Ok(status))) => format!("process exited with {status}"),
        Some(Ok(Err(error))) => error.to_string(),
        None => {
            child.kill().await?;
            "initialization cancelled; review effects before retrying".into()
        }
        Some(Err(_)) => {
            let _ = child.kill().await;
            "command timed out after 10 minutes".into()
        }
    };
    // Keep complete output on disk, return only a bounded tail in the API error.
    let tail = read_command_log_tail(&log_path).await?;
    Err(WorktreeSettingsError::CommandFailed {
        path: working_dir.display().to_string(),
        detail: format!("{detail}. Log: {}\n{tail}", log_path.display()),
    })
}

pub async fn read_command_log_tail(path: &Path) -> Result<String, std::io::Error> {
    use tokio::io::{AsyncReadExt, AsyncSeekExt};
    let mut file = tokio::fs::File::open(path).await?;
    let len = file.metadata().await?.len();
    file.seek(std::io::SeekFrom::Start(len.saturating_sub(8192)))
        .await?;
    let mut tail = Vec::new();
    file.read_to_end(&mut tail).await?;
    Ok(String::from_utf8_lossy(&tail).into_owned())
}

fn lifecycle_process(
    command: &str,
    project_id: Uuid,
    workspace_id: Uuid,
    working_dir: &Path,
) -> tokio::process::Command {
    let (program, args): (&str, Vec<&str>) = if cfg!(target_os = "windows") {
        ("cmd", vec!["/D", "/C", command])
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
    process
}

#[cfg(test)]
mod tests {
    use super::{ProjectWorktreeSettings, normalize_settings, should_prompt_cleanup};

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
}
