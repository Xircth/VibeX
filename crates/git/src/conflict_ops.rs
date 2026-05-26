use std::path::Path;

use crate::{ConflictOp, GitCli, GitService, GitServiceError};

impl GitService {
    /// Return true if a rebase is currently in progress in this worktree.
    pub fn is_rebase_in_progress(&self, worktree_path: &Path) -> Result<bool, GitServiceError> {
        let git = GitCli::new();
        git.is_rebase_in_progress(worktree_path).map_err(|e| {
            GitServiceError::InvalidRepository(format!("git rebase state check failed: {e}"))
        })
    }

    pub fn detect_conflict_op(
        &self,
        worktree_path: &Path,
    ) -> Result<Option<ConflictOp>, GitServiceError> {
        let git = GitCli::new();
        if git.is_rebase_in_progress(worktree_path).unwrap_or(false) {
            return Ok(Some(ConflictOp::Rebase));
        }
        if git.is_merge_in_progress(worktree_path).unwrap_or(false) {
            return Ok(Some(ConflictOp::Merge));
        }
        if git
            .is_cherry_pick_in_progress(worktree_path)
            .unwrap_or(false)
        {
            return Ok(Some(ConflictOp::CherryPick));
        }
        if git.is_revert_in_progress(worktree_path).unwrap_or(false) {
            return Ok(Some(ConflictOp::Revert));
        }
        Ok(None)
    }

    /// List conflicted (unmerged) files in the worktree.
    pub fn get_conflicted_files(
        &self,
        worktree_path: &Path,
    ) -> Result<Vec<String>, GitServiceError> {
        let git = GitCli::new();
        git.get_conflicted_files(worktree_path).map_err(|e| {
            GitServiceError::InvalidRepository(format!("git diff for conflicts failed: {e}"))
        })
    }

    /// Abort an in-progress rebase in this worktree (no-op if none).
    pub fn abort_rebase(&self, worktree_path: &Path) -> Result<(), GitServiceError> {
        let git = GitCli::new();
        git.abort_rebase(worktree_path).map_err(|e| {
            GitServiceError::InvalidRepository(format!("git rebase --abort failed: {e}"))
        })
    }

    /// Continue an in-progress rebase. Fails if there are unresolved conflicts.
    pub fn continue_rebase(&self, worktree_path: &Path) -> Result<(), GitServiceError> {
        let git = GitCli::new();
        git.continue_rebase(worktree_path).map_err(|e| {
            GitServiceError::InvalidRepository(format!("git rebase --continue failed: {e}"))
        })
    }

    pub fn abort_conflicts(&self, worktree_path: &Path) -> Result<(), GitServiceError> {
        let git = GitCli::new();
        if git.is_rebase_in_progress(worktree_path).unwrap_or(false) {
            let has_conflicts = !self
                .get_conflicted_files(worktree_path)
                .unwrap_or_default()
                .is_empty();
            if has_conflicts {
                return self.abort_rebase(worktree_path);
            }
            return git.quit_rebase(worktree_path).map_err(|e| {
                GitServiceError::InvalidRepository(format!("git rebase --quit failed: {e}"))
            });
        }
        if git.is_merge_in_progress(worktree_path).unwrap_or(false) {
            return git.abort_merge(worktree_path).map_err(|e| {
                GitServiceError::InvalidRepository(format!("git merge --abort failed: {e}"))
            });
        }
        if git
            .is_cherry_pick_in_progress(worktree_path)
            .unwrap_or(false)
        {
            return git.abort_cherry_pick(worktree_path).map_err(|e| {
                GitServiceError::InvalidRepository(format!("git cherry-pick --abort failed: {e}"))
            });
        }
        if git.is_revert_in_progress(worktree_path).unwrap_or(false) {
            return git.abort_revert(worktree_path).map_err(|e| {
                GitServiceError::InvalidRepository(format!("git revert --abort failed: {e}"))
            });
        }
        Ok(())
    }
}
