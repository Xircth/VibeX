use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use chrono::{DateTime, Utc};
use git2::{BranchType, Repository};

use crate::{
    GitBranch, GitCli, GitService, GitServiceError, WorktreeResetOptions, WorktreeResetOutcome,
    WorktreeStatus,
};

impl GitService {
    pub fn is_worktree_clean(&self, worktree_path: &Path) -> Result<bool, GitServiceError> {
        let repo = self.open_repo(worktree_path)?;
        match self.check_worktree_clean(&repo) {
            Ok(()) => Ok(true),
            Err(GitServiceError::WorktreeDirty(_, _)) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Check if the worktree is clean with no uncommitted tracked changes.
    pub(crate) fn check_worktree_clean(&self, repo: &Repository) -> Result<(), GitServiceError> {
        let mut status_options = git2::StatusOptions::new();
        status_options
            .include_untracked(false)
            .include_ignored(false);

        let statuses = repo.statuses(Some(&mut status_options))?;

        if !statuses.is_empty() {
            let mut dirty_files = Vec::new();
            for entry in statuses.iter() {
                let status = entry.status();
                if status.intersects(
                    git2::Status::INDEX_MODIFIED
                        | git2::Status::INDEX_NEW
                        | git2::Status::INDEX_DELETED
                        | git2::Status::INDEX_RENAMED
                        | git2::Status::INDEX_TYPECHANGE
                        | git2::Status::WT_MODIFIED
                        | git2::Status::WT_DELETED
                        | git2::Status::WT_RENAMED
                        | git2::Status::WT_TYPECHANGE,
                ) && let Some(path) = entry.path()
                {
                    dirty_files.push(path.to_string());
                }
            }

            if !dirty_files.is_empty() {
                let branch_name = repo
                    .head()
                    .ok()
                    .and_then(|h| h.shorthand().map(|s| s.to_string()))
                    .unwrap_or_else(|| "unknown branch".to_string());
                return Err(GitServiceError::WorktreeDirty(
                    branch_name,
                    dirty_files.join(", "),
                ));
            }
        }

        Ok(())
    }

    fn canonicalize_path_for_compare(path: &Path) -> PathBuf {
        let normalized = utils::path::normalize_macos_private_alias(path);
        std::fs::canonicalize(&normalized).unwrap_or(normalized)
    }

    /// Find where a branch is currently checked out.
    pub(crate) fn find_checkout_path_for_branch(
        &self,
        repo_path: &Path,
        branch_name: &str,
    ) -> Result<Option<PathBuf>, GitServiceError> {
        let git_cli = GitCli::new();
        let worktrees = git_cli.list_worktrees(repo_path).map_err(|e| {
            GitServiceError::InvalidRepository(format!("git worktree list failed: {e}"))
        })?;

        for worktree in worktrees {
            if let Some(ref branch) = worktree.branch
                && branch == branch_name
            {
                return Ok(Some(PathBuf::from(worktree.path)));
            }
        }
        Ok(None)
    }

    /// Find the local worktree path where a branch is currently checked out.
    pub fn find_worktree_path_for_branch(
        &self,
        repo_path: &Path,
        branch_name: &str,
    ) -> Result<Option<PathBuf>, GitServiceError> {
        self.find_checkout_path_for_branch(repo_path, branch_name)
    }

    /// Return the full worktree status including all entries.
    pub fn get_worktree_status(
        &self,
        worktree_path: &Path,
    ) -> Result<WorktreeStatus, GitServiceError> {
        let cli = GitCli::new();
        cli.get_worktree_status(worktree_path)
            .map_err(|e| GitServiceError::InvalidRepository(format!("git status failed: {e}")))
    }

    /// Return (uncommitted_tracked_changes, untracked_files) counts in worktree.
    pub fn get_worktree_change_counts(
        &self,
        worktree_path: &Path,
    ) -> Result<(usize, usize), GitServiceError> {
        let st = self.get_worktree_status(worktree_path)?;
        Ok((st.uncommitted_tracked, st.untracked))
    }

    /// Evaluate whether any action is needed to reset to `target_commit_oid` and
    /// optionally perform the actions.
    pub fn reconcile_worktree_to_commit(
        &self,
        worktree_path: &Path,
        target_commit_oid: &str,
        options: WorktreeResetOptions,
    ) -> WorktreeResetOutcome {
        let WorktreeResetOptions {
            perform_reset,
            force_when_dirty,
            is_dirty,
            log_skip_when_dirty,
        } = options;

        let head_oid = self.get_head_info(worktree_path).ok().map(|h| h.oid);
        let mut outcome = WorktreeResetOutcome::default();

        if head_oid.as_deref() != Some(target_commit_oid) || is_dirty {
            outcome.needed = true;

            if perform_reset {
                if is_dirty && !force_when_dirty {
                    if log_skip_when_dirty {
                        tracing::warn!("Worktree dirty; skipping reset as not forced");
                    }
                } else if let Err(e) = self.reset_worktree_to_commit(
                    worktree_path,
                    target_commit_oid,
                    force_when_dirty,
                ) {
                    tracing::error!("Failed to reset worktree: {}", e);
                } else {
                    outcome.applied = true;
                }
            }
        }

        outcome
    }

    /// Reset the given worktree to the specified commit SHA.
    /// If `force` is false and the worktree is dirty, returns WorktreeDirty error.
    pub fn reset_worktree_to_commit(
        &self,
        worktree_path: &Path,
        commit_sha: &str,
        force: bool,
    ) -> Result<(), GitServiceError> {
        let repo = self.open_repo(worktree_path)?;
        if !force {
            self.check_worktree_clean(&repo)?;
        }
        let cli = GitCli::new();
        cli.git(worktree_path, ["reset", "--hard", commit_sha])
            .map_err(|e| {
                GitServiceError::InvalidRepository(format!("git reset --hard failed: {e}"))
            })?;
        let _ = cli.git(worktree_path, ["sparse-checkout", "reapply"]);
        Ok(())
    }

    /// Add a worktree for a branch, optionally creating the branch.
    pub fn add_worktree(
        &self,
        repo_path: &Path,
        worktree_path: &Path,
        branch: &str,
        create_branch: bool,
    ) -> Result<(), GitServiceError> {
        let git = GitCli::new();
        git.worktree_add(repo_path, worktree_path, branch, create_branch)
            .map_err(|e| GitServiceError::InvalidRepository(e.to_string()))?;
        Ok(())
    }

    /// Add a worktree by creating a new branch from an explicit start point.
    pub fn add_worktree_from_ref(
        &self,
        repo_path: &Path,
        worktree_path: &Path,
        branch: &str,
        start_point: &str,
    ) -> Result<(), GitServiceError> {
        let git = GitCli::new();
        git.worktree_add_from_ref(repo_path, worktree_path, branch, start_point)
            .map_err(|e| GitServiceError::InvalidRepository(e.to_string()))?;
        Ok(())
    }

    /// Remove a worktree.
    pub fn remove_worktree(
        &self,
        repo_path: &Path,
        worktree_path: &Path,
        force: bool,
    ) -> Result<(), GitServiceError> {
        let git = GitCli::new();
        git.worktree_remove(repo_path, worktree_path, force)
            .map_err(|e| GitServiceError::InvalidRepository(e.to_string()))?;
        Ok(())
    }

    /// Move a worktree to a new location.
    pub fn move_worktree(
        &self,
        repo_path: &Path,
        old_path: &Path,
        new_path: &Path,
    ) -> Result<(), GitServiceError> {
        let git = GitCli::new();
        git.worktree_move(repo_path, old_path, new_path)
            .map_err(|e| GitServiceError::InvalidRepository(e.to_string()))?;
        Ok(())
    }

    pub fn prune_worktrees(&self, repo_path: &Path) -> Result<(), GitServiceError> {
        let git = GitCli::new();
        git.worktree_prune(repo_path)
            .map_err(|e| GitServiceError::InvalidRepository(e.to_string()))?;
        Ok(())
    }

    pub fn get_all_branches(&self, repo_path: &Path) -> Result<Vec<GitBranch>, git2::Error> {
        let repo = Repository::open(repo_path)?;
        let current_branch = self.get_current_branch(repo_path).unwrap_or_default();
        let mut branches = Vec::new();
        let repo_root = Self::canonicalize_path_for_compare(repo_path);
        let worktree_paths_by_branch = GitCli::new()
            .list_worktrees(repo_path)
            .map(|entries| {
                let mut by_branch = HashMap::new();
                for entry in entries {
                    if let Some(branch) = entry.branch {
                        by_branch.insert(branch, entry.path);
                    }
                }
                by_branch
            })
            .unwrap_or_default();

        let get_last_commit_date = |branch: &git2::Branch| -> Result<DateTime<Utc>, git2::Error> {
            if let Some(target) = branch.get().target()
                && let Ok(commit) = repo.find_commit(target)
            {
                let timestamp = commit.time().seconds();
                return Ok(DateTime::from_timestamp(timestamp, 0).unwrap_or_else(Utc::now));
            }
            Ok(Utc::now())
        };

        let local_branches = repo.branches(Some(BranchType::Local))?;
        for branch_result in local_branches {
            let (branch, _) = branch_result?;
            if let Some(name) = branch.name()? {
                let last_commit_date = get_last_commit_date(&branch)?;
                let worktree_path = worktree_paths_by_branch.get(name).cloned();
                let is_worktree = worktree_path
                    .as_deref()
                    .map(Path::new)
                    .map(Self::canonicalize_path_for_compare)
                    .is_some_and(|path| path != repo_root);
                branches.push(GitBranch {
                    name: name.to_string(),
                    is_current: name == current_branch,
                    is_remote: false,
                    is_worktree,
                    worktree_path,
                    last_commit_date,
                });
            }
        }

        let remote_branches = repo.branches(Some(BranchType::Remote))?;
        for branch_result in remote_branches {
            let (branch, _) = branch_result?;
            if let Some(name) = branch.name()?
                && !name.ends_with("/HEAD")
            {
                let last_commit_date = get_last_commit_date(&branch)?;
                branches.push(GitBranch {
                    name: name.to_string(),
                    is_current: false,
                    is_remote: true,
                    is_worktree: false,
                    worktree_path: None,
                    last_commit_date,
                });
            }
        }

        branches.sort_by(|a, b| {
            if a.is_current && !b.is_current {
                std::cmp::Ordering::Less
            } else if !a.is_current && b.is_current {
                std::cmp::Ordering::Greater
            } else {
                b.last_commit_date.cmp(&a.last_commit_date)
            }
        });

        Ok(branches)
    }
}
