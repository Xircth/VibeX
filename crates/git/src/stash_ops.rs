use std::path::Path;

use crate::{GitCli, GitService, GitServiceError, StashEntry, types::parse_stash_list};

impl GitService {
    /// Stash the working tree of `worktree_path`. Returns `false` when there
    /// were no local changes to stash.
    pub fn stash_push(
        &self,
        worktree_path: &Path,
        message: Option<&str>,
        include_untracked: bool,
    ) -> Result<bool, GitServiceError> {
        Ok(GitCli::new().stash_push(worktree_path, message, include_untracked)?)
    }

    /// List the stash stack (most recent first, `stash@{0}` = index 0).
    pub fn stash_list(&self, worktree_path: &Path) -> Result<Vec<StashEntry>, GitServiceError> {
        let raw = GitCli::new().stash_list_raw(worktree_path)?;
        Ok(parse_stash_list(&raw))
    }

    /// Apply the stash at `index` without removing it from the stack.
    pub fn stash_apply(&self, worktree_path: &Path, index: usize) -> Result<(), GitServiceError> {
        Ok(GitCli::new().stash_apply(worktree_path, index)?)
    }

    /// Apply the stash at `index` and drop it from the stack.
    pub fn stash_pop(&self, worktree_path: &Path, index: usize) -> Result<(), GitServiceError> {
        Ok(GitCli::new().stash_pop(worktree_path, index)?)
    }

    /// Discard the stash at `index` without applying it.
    pub fn stash_drop(&self, worktree_path: &Path, index: usize) -> Result<(), GitServiceError> {
        Ok(GitCli::new().stash_drop(worktree_path, index)?)
    }

    /// Return the patch for the stash at `index`.
    pub fn stash_show(&self, worktree_path: &Path, index: usize) -> Result<String, GitServiceError> {
        Ok(GitCli::new().stash_show(worktree_path, index)?)
    }
}
