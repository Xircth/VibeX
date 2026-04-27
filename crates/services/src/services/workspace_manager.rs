use std::path::{Path, PathBuf};

use db::models::{repo::Repo, workspace::Workspace as DbWorkspace};
use sqlx::{Pool, Sqlite};
use thiserror::Error;
use tracing::{debug, error, info, warn};
use uuid::Uuid;

use super::worktree_manager::{WorktreeCleanup, WorktreeError, WorktreeManager};

#[derive(Debug, Clone)]
pub struct RepoWorkspaceInput {
    pub repo: Repo,
    pub target_branch: String,
}

impl RepoWorkspaceInput {
    pub fn new(repo: Repo, target_branch: String) -> Self {
        Self {
            repo,
            target_branch,
        }
    }
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use uuid::Uuid;

    use super::*;

    fn test_repo(path: PathBuf) -> Repo {
        Repo {
            id: Uuid::new_v4(),
            path,
            name: "project".to_string(),
            display_name: "project".to_string(),
            setup_script: None,
            cleanup_script: None,
            archive_script: None,
            copy_files: None,
            parallel_setup_script: false,
            dev_server_script: None,
            default_target_branch: Some("main".to_string()),
            default_working_dir: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    #[tokio::test]
    async fn ensure_workspace_refuses_user_project_directory_as_container() {
        let temp = tempfile::tempdir().expect("tempdir");
        let project_dir = temp.path().join("project");
        std::fs::create_dir_all(&project_dir).expect("project dir");
        let repo = test_repo(project_dir.clone());

        let result = WorkspaceManager::ensure_workspace_exists(&project_dir, &[repo], "main").await;

        assert!(matches!(
            result,
            Err(WorkspaceError::UnsafeWorkspacePath(path)) if path == project_dir
        ));
        assert!(project_dir.exists());
    }
}

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error(transparent)]
    Worktree(#[from] WorktreeError),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("No repositories provided")]
    NoRepositories,
    #[error("Unsafe workspace path outside VibeUltra-owned storage: {0}")]
    UnsafeWorkspacePath(PathBuf),
    #[error("Partial workspace creation failed: {0}")]
    PartialCreation(String),
}

/// Info about a single repo's worktree within a workspace
#[derive(Debug, Clone)]
pub struct RepoWorktree {
    pub repo_id: Uuid,
    pub repo_name: String,
    pub source_repo_path: PathBuf,
    pub worktree_path: PathBuf,
}

/// A container directory holding worktrees for all project repos
#[derive(Debug, Clone)]
pub struct WorktreeContainer {
    pub workspace_dir: PathBuf,
    pub worktrees: Vec<RepoWorktree>,
}

pub struct WorkspaceManager;

impl WorkspaceManager {
    const CUSTOM_WORKSPACE_DIR_NAME: &'static str = ".vibe-ultra-workspaces";

    fn canonicalize_for_safety(path: &Path) -> PathBuf {
        if let Ok(path) = dunce::canonicalize(path) {
            return path;
        }

        let mut missing_segments = Vec::new();
        let mut cursor = path;
        while !cursor.exists() {
            let Some(name) = cursor.file_name() else {
                break;
            };
            missing_segments.push(name.to_os_string());
            let Some(parent) = cursor.parent() else {
                break;
            };
            cursor = parent;
        }

        let mut resolved = dunce::canonicalize(cursor).unwrap_or_else(|_| cursor.to_path_buf());
        for segment in missing_segments.iter().rev() {
            resolved.push(segment);
        }
        resolved
    }

    pub fn is_app_owned_workspace_dir(path: &Path) -> bool {
        let path = Self::canonicalize_for_safety(path);
        let default_base =
            Self::canonicalize_for_safety(&WorktreeManager::get_default_worktree_base_dir());

        if path == default_base || path.starts_with(&default_base) {
            return true;
        }

        path.ancestors().any(|ancestor| {
            ancestor
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name == Self::CUSTOM_WORKSPACE_DIR_NAME)
        })
    }

    fn overlaps_known_repo(path: &Path, repos: &[Repo]) -> bool {
        let path = Self::canonicalize_for_safety(path);

        repos.iter().any(|repo| {
            let repo_path = Self::canonicalize_for_safety(&repo.path);
            path == repo_path || path.starts_with(&repo_path) || repo_path.starts_with(&path)
        })
    }

    fn refuse_unsafe_cleanup(path: &Path, repos: &[Repo]) -> bool {
        if !Self::is_app_owned_workspace_dir(path) {
            warn!(
                "Refusing to clean workspace path outside VibeUltra-owned workspace storage: {}",
                path.display()
            );
            return true;
        }

        if Self::overlaps_known_repo(path, repos) {
            warn!(
                "Refusing to clean workspace path that overlaps a registered repository: {}",
                path.display()
            );
            return true;
        }

        false
    }

    fn validate_workspace_container_path(path: &Path) -> Result<(), WorkspaceError> {
        if Self::is_app_owned_workspace_dir(path) {
            return Ok(());
        }

        warn!(
            "Refusing to use workspace path outside VibeUltra-owned workspace storage: {}",
            path.display()
        );
        Err(WorkspaceError::UnsafeWorkspacePath(path.to_path_buf()))
    }

    /// Create a workspace with worktrees for all repositories.
    /// On failure, rolls back any already-created worktrees.
    pub async fn create_workspace(
        workspace_dir: &Path,
        repos: &[RepoWorkspaceInput],
        branch_name: &str,
    ) -> Result<WorktreeContainer, WorkspaceError> {
        if repos.is_empty() {
            return Err(WorkspaceError::NoRepositories);
        }
        Self::validate_workspace_container_path(workspace_dir)?;

        info!(
            "Creating workspace at {} with {} repositories",
            workspace_dir.display(),
            repos.len()
        );

        tokio::fs::create_dir_all(workspace_dir).await?;

        let mut created_worktrees: Vec<RepoWorktree> = Vec::new();

        for input in repos {
            let worktree_path = workspace_dir.join(&input.repo.name);

            debug!(
                "Creating worktree for repo '{}' at {}",
                input.repo.name,
                worktree_path.display()
            );

            match WorktreeManager::create_worktree(
                &input.repo.path,
                branch_name,
                &worktree_path,
                &input.target_branch,
                true,
            )
            .await
            {
                Ok(()) => {
                    created_worktrees.push(RepoWorktree {
                        repo_id: input.repo.id,
                        repo_name: input.repo.name.clone(),
                        source_repo_path: input.repo.path.clone(),
                        worktree_path,
                    });
                }
                Err(e) => {
                    error!(
                        "Failed to create worktree for repo '{}': {}. Rolling back...",
                        input.repo.name, e
                    );

                    // Rollback: cleanup all worktrees we've created so far
                    Self::cleanup_created_worktrees(&created_worktrees).await;

                    // Also remove the workspace directory if it's empty
                    if let Err(cleanup_err) = tokio::fs::remove_dir(workspace_dir).await {
                        debug!(
                            "Could not remove workspace dir during rollback: {}",
                            cleanup_err
                        );
                    }

                    return Err(WorkspaceError::PartialCreation(format!(
                        "Failed to create worktree for repo '{}': {}",
                        input.repo.name, e
                    )));
                }
            }
        }

        info!(
            "Successfully created workspace with {} worktrees",
            created_worktrees.len()
        );

        Ok(WorktreeContainer {
            workspace_dir: workspace_dir.to_path_buf(),
            worktrees: created_worktrees,
        })
    }

    /// Ensure all worktrees in a workspace exist (for cold restart scenarios)
    pub async fn ensure_workspace_exists(
        workspace_dir: &Path,
        repos: &[Repo],
        branch_name: &str,
    ) -> Result<(), WorkspaceError> {
        if repos.is_empty() {
            return Err(WorkspaceError::NoRepositories);
        }
        Self::validate_workspace_container_path(workspace_dir)?;

        // Try legacy migration first (single repo projects only)
        // Old layout had worktree directly at workspace_dir; new layout has it at workspace_dir/{repo_name}
        if repos.len() == 1 && Self::migrate_legacy_worktree(workspace_dir, &repos[0]).await? {
            return Ok(());
        }

        if !workspace_dir.exists() {
            tokio::fs::create_dir_all(workspace_dir).await?;
        }

        for repo in repos {
            let worktree_path = workspace_dir.join(&repo.name);

            debug!(
                "Ensuring worktree exists for repo '{}' at {}",
                repo.name,
                worktree_path.display()
            );

            WorktreeManager::ensure_worktree_exists(&repo.path, branch_name, &worktree_path)
                .await?;
        }

        Ok(())
    }

    /// Clean up all worktrees in a workspace
    pub async fn cleanup_workspace(
        workspace_dir: &Path,
        repos: &[Repo],
    ) -> Result<(), WorkspaceError> {
        info!("Cleaning up workspace at {}", workspace_dir.display());
        if Self::refuse_unsafe_cleanup(workspace_dir, repos) {
            return Ok(());
        }

        let cleanup_data: Vec<WorktreeCleanup> = repos
            .iter()
            .map(|repo| {
                let worktree_path = workspace_dir.join(&repo.name);
                WorktreeCleanup::new(worktree_path, Some(repo.path.clone()))
            })
            .collect();

        WorktreeManager::batch_cleanup_worktrees(&cleanup_data).await?;

        // Remove the workspace directory itself
        if workspace_dir.exists()
            && let Err(e) = tokio::fs::remove_dir_all(workspace_dir).await
        {
            debug!(
                "Could not remove workspace directory {}: {}",
                workspace_dir.display(),
                e
            );
        }

        Ok(())
    }

    /// Get the base directory for workspaces (same as worktree base dir)
    pub fn get_workspace_base_dir() -> PathBuf {
        WorktreeManager::get_worktree_base_dir()
    }

    /// Migrate a legacy single-worktree layout to the new workspace layout.
    /// Old layout: workspace_dir IS the worktree
    /// New layout: workspace_dir contains worktrees at workspace_dir/{repo_name}
    ///
    /// Returns Ok(true) if migration was performed, Ok(false) if no migration needed.
    pub async fn migrate_legacy_worktree(
        workspace_dir: &Path,
        repo: &Repo,
    ) -> Result<bool, WorkspaceError> {
        let expected_worktree_path = workspace_dir.join(&repo.name);

        // Detect old-style: workspace_dir exists AND has .git file (worktree marker)
        // AND expected new location doesn't exist
        let git_file = workspace_dir.join(".git");
        let is_old_style = workspace_dir.exists()
            && git_file.exists()
            && git_file.is_file() // .git file = worktree, .git dir = main repo
            && !expected_worktree_path.exists();

        if !is_old_style {
            return Ok(false);
        }

        info!(
            "Detected legacy worktree at {}, migrating to new layout",
            workspace_dir.display()
        );

        // Move old worktree to temp location (can't move into subdirectory of itself)
        let temp_name = format!(
            "{}-migrating",
            workspace_dir
                .file_name()
                .map(|n| n.to_string_lossy())
                .unwrap_or_default()
        );
        let temp_path = workspace_dir.with_file_name(temp_name);

        WorktreeManager::move_worktree(&repo.path, workspace_dir, &temp_path).await?;

        // Create new workspace directory
        tokio::fs::create_dir_all(workspace_dir).await?;

        // Move worktree to final location using git worktree move
        WorktreeManager::move_worktree(&repo.path, &temp_path, &expected_worktree_path).await?;

        if temp_path.exists() {
            let _ = tokio::fs::remove_dir_all(&temp_path).await;
        }

        info!(
            "Successfully migrated legacy worktree to {}",
            expected_worktree_path.display()
        );

        Ok(true)
    }

    /// Helper to cleanup worktrees during rollback
    async fn cleanup_created_worktrees(worktrees: &[RepoWorktree]) {
        for worktree in worktrees {
            let cleanup = WorktreeCleanup::new(
                worktree.worktree_path.clone(),
                Some(worktree.source_repo_path.clone()),
            );

            if let Err(e) = WorktreeManager::cleanup_worktree(&cleanup).await {
                error!(
                    "Failed to cleanup worktree '{}' during rollback: {}",
                    worktree.repo_name, e
                );
            }
        }
    }

    pub async fn cleanup_orphan_workspaces(db: &Pool<Sqlite>) {
        if std::env::var("DISABLE_WORKTREE_CLEANUP").is_ok() {
            info!(
                "Orphan workspace cleanup is disabled via DISABLE_WORKTREE_CLEANUP environment variable"
            );
            return;
        }

        // Always clean up the default directory
        let default_dir = WorktreeManager::get_default_worktree_base_dir();
        Self::cleanup_orphans_in_directory(db, &default_dir).await;

        // Also clean up custom directory if it's different from the default
        let current_dir = Self::get_workspace_base_dir();
        if current_dir != default_dir {
            Self::cleanup_orphans_in_directory(db, &current_dir).await;
        }
    }

    async fn cleanup_orphans_in_directory(db: &Pool<Sqlite>, workspace_base_dir: &Path) {
        if !Self::is_app_owned_workspace_dir(workspace_base_dir) {
            warn!(
                "Skipping orphan cleanup for non VibeUltra-owned workspace directory: {}",
                workspace_base_dir.display()
            );
            return;
        }

        if !workspace_base_dir.exists() {
            debug!(
                "Workspace base directory {} does not exist, skipping orphan cleanup",
                workspace_base_dir.display()
            );
            return;
        }

        let entries = match std::fs::read_dir(workspace_base_dir) {
            Ok(entries) => entries,
            Err(e) => {
                error!(
                    "Failed to read workspace base directory {}: {}",
                    workspace_base_dir.display(),
                    e
                );
                return;
            }
        };

        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(e) => {
                    warn!("Failed to read directory entry: {}", e);
                    continue;
                }
            };

            let path = entry.path();
            if !path.is_dir() {
                continue;
            }

            let workspace_path_str = path.to_string_lossy().to_string();
            if let Ok(false) = DbWorkspace::container_ref_exists(db, &workspace_path_str).await {
                info!("Found orphaned workspace: {}", workspace_path_str);
                if let Err(e) = Self::cleanup_workspace_without_repos(&path).await {
                    error!(
                        "Failed to remove orphaned workspace {}: {}",
                        workspace_path_str, e
                    );
                } else {
                    info!(
                        "Successfully removed orphaned workspace: {}",
                        workspace_path_str
                    );
                }
            }
        }
    }

    async fn cleanup_workspace_without_repos(workspace_dir: &Path) -> Result<(), WorkspaceError> {
        info!(
            "Cleaning up orphaned workspace at {}",
            workspace_dir.display()
        );
        if !Self::is_app_owned_workspace_dir(workspace_dir) {
            warn!(
                "Refusing to remove orphan workspace outside VibeUltra-owned storage: {}",
                workspace_dir.display()
            );
            return Ok(());
        }

        let entries = match std::fs::read_dir(workspace_dir) {
            Ok(entries) => entries,
            Err(e) => {
                debug!(
                    "Cannot read workspace directory {}, attempting direct removal: {}",
                    workspace_dir.display(),
                    e
                );
                return tokio::fs::remove_dir_all(workspace_dir)
                    .await
                    .map_err(WorkspaceError::Io);
            }
        };

        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.is_dir()
                && let Err(e) = WorktreeManager::cleanup_suspected_worktree(&path).await
            {
                warn!("Failed to cleanup suspected worktree: {}", e);
            }
        }

        if workspace_dir.exists()
            && let Err(e) = tokio::fs::remove_dir_all(workspace_dir).await
        {
            debug!(
                "Could not remove workspace directory {}: {}",
                workspace_dir.display(),
                e
            );
        }

        Ok(())
    }
}
