use std::path::Path;

use git2::Repository;

use crate::{GitCli, GitCliError, GitService, GitServiceError};

impl GitService {
    /// Merge changes from a task branch into the base branch.
    pub fn merge_changes(
        &self,
        base_worktree_path: &Path,
        task_worktree_path: &Path,
        task_branch_name: &str,
        base_branch_name: &str,
        commit_message: &str,
    ) -> Result<String, GitServiceError> {
        let task_repo = self.open_repo(task_worktree_path)?;
        let base_repo = self.open_repo(base_worktree_path)?;

        let (_, task_behind) =
            self.get_branch_status(base_worktree_path, task_branch_name, base_branch_name)?;

        if task_behind > 0 {
            return Err(GitServiceError::BranchesDiverged(format!(
                "Cannot merge: base branch '{base_branch_name}' is {task_behind} commits ahead of task branch '{task_branch_name}'. The base branch has moved forward since the task was created.",
            )));
        }

        match self.find_checkout_path_for_branch(base_worktree_path, base_branch_name)? {
            Some(base_checkout_path) => {
                let git_cli = GitCli::new();

                if git_cli
                    .has_staged_changes(&base_checkout_path)
                    .map_err(|e| {
                        GitServiceError::InvalidRepository(format!("git diff --cached failed: {e}"))
                    })?
                {
                    return Err(GitServiceError::WorktreeDirty(
                        base_branch_name.to_string(),
                        "staged changes present".to_string(),
                    ));
                }

                self.ensure_cli_commit_identity(&base_checkout_path)?;
                let sha = git_cli
                    .merge_squash_commit(
                        &base_checkout_path,
                        base_branch_name,
                        task_branch_name,
                        commit_message,
                    )
                    .map_err(|e| {
                        GitServiceError::InvalidRepository(format!("CLI merge failed: {e}"))
                    })?;

                let task_refname = format!("refs/heads/{task_branch_name}");
                git_cli
                    .update_ref(base_worktree_path, &task_refname, &sha)
                    .map_err(|e| {
                        GitServiceError::InvalidRepository(format!("git update-ref failed: {e}"))
                    })?;

                Ok(sha)
            }
            None => {
                // No checked-out worktree holds the base branch, so (unlike the
                // CLI path above) there is no working tree that could carry staged
                // changes — the squash is written straight to refs via git2. The
                // staged-changes guard is therefore intentionally not applicable here.
                let task_branch = Self::find_branch(&task_repo, task_branch_name)?;
                let base_branch = Self::find_branch(&task_repo, base_branch_name)?;
                let base_commit = base_branch.get().peel_to_commit()?;
                let task_commit = task_branch.get().peel_to_commit()?;

                let signature = self.signature_with_fallback(&task_repo)?;
                let squash_commit_id = self.perform_squash_merge(
                    &task_repo,
                    &base_commit,
                    &task_commit,
                    &signature,
                    commit_message,
                    base_branch_name,
                )?;

                let task_refname = format!("refs/heads/{task_branch_name}");
                base_repo.reference(
                    &task_refname,
                    squash_commit_id,
                    true,
                    "Reset task branch after squash merge",
                )?;

                Ok(squash_commit_id.to_string())
            }
        }
    }

    /// Perform a squash merge of task branch into base branch, but fail on conflicts.
    fn perform_squash_merge(
        &self,
        repo: &Repository,
        base_commit: &git2::Commit,
        task_commit: &git2::Commit,
        signature: &git2::Signature,
        commit_message: &str,
        base_branch_name: &str,
    ) -> Result<git2::Oid, GitServiceError> {
        let mut merge_opts = git2::MergeOptions::new();
        merge_opts.find_renames(true);
        merge_opts.fail_on_conflict(true);
        let mut index = repo.merge_commits(base_commit, task_commit, Some(&merge_opts))?;

        if index.has_conflicts() {
            return Err(GitServiceError::MergeConflicts {
                message: "Merge failed due to conflicts. Please resolve conflicts manually."
                    .to_string(),
                conflicted_files: vec![],
            });
        }

        let tree_id = index.write_tree_to(repo)?;
        let tree = repo.find_tree(tree_id)?;
        let squash_commit_id = repo.commit(
            None,
            signature,
            signature,
            commit_message,
            &tree,
            &[base_commit],
        )?;

        let refname = format!("refs/heads/{base_branch_name}");
        repo.reference(&refname, squash_commit_id, true, "Squash merge")?;

        Ok(squash_commit_id)
    }

    /// Rebase a worktree branch onto a new base.
    pub fn rebase_branch(
        &self,
        repo_path: &Path,
        worktree_path: &Path,
        new_base_branch: &str,
        old_base_branch: &str,
        task_branch: &str,
    ) -> Result<String, GitServiceError> {
        let worktree_repo = Repository::open(worktree_path)?;
        let main_repo = self.open_repo(repo_path)?;

        self.check_worktree_clean(&worktree_repo)?;

        let git = GitCli::new();
        if git.is_rebase_in_progress(worktree_path).unwrap_or(false) {
            return Err(GitServiceError::RebaseInProgress);
        }

        let nbr = Self::find_branch(&main_repo, new_base_branch)?.into_reference();
        if nbr.is_remote() {
            self.fetch_branch_from_remote(&main_repo, &nbr)?;
        }

        self.ensure_cli_commit_identity(worktree_path)?;
        match git.rebase_onto(worktree_path, new_base_branch, old_base_branch, task_branch) {
            Ok(()) => {}
            Err(GitCliError::RebaseInProgress) => {
                return Err(GitServiceError::RebaseInProgress);
            }
            Err(GitCliError::CommandFailed(stderr)) => {
                let conflicted_files = git.get_conflicted_files(worktree_path).unwrap_or_default();
                let has_conflict_state = !conflicted_files.is_empty()
                    || git.is_rebase_in_progress(worktree_path).unwrap_or(false);
                let looks_like_conflict =
                    has_conflict_state || Self::looks_like_conflict_text(&stderr);
                if looks_like_conflict {
                    let attempt_branch = worktree_repo
                        .head()
                        .ok()
                        .and_then(|h| h.shorthand().map(|s| s.to_string()))
                        .unwrap_or_else(|| "(unknown)".to_string());
                    let files_part = if conflicted_files.is_empty() {
                        "".to_string()
                    } else {
                        let mut sample = conflicted_files.clone();
                        let total = sample.len();
                        sample.truncate(10);
                        let list = sample.join(", ");
                        if total > sample.len() {
                            format!(
                                " Conflicted files (showing {} of {}): {}.",
                                sample.len(),
                                total,
                                list
                            )
                        } else {
                            format!(" Conflicted files: {list}.")
                        }
                    };
                    let msg = format!(
                        "Rebase encountered merge conflicts while rebasing '{attempt_branch}' onto '{new_base_branch}'.{files_part} Resolve conflicts and then continue or abort."
                    );
                    return Err(GitServiceError::MergeConflicts {
                        message: msg,
                        conflicted_files,
                    });
                }
                return Err(GitServiceError::InvalidRepository(format!(
                    "Rebase failed: {}",
                    Self::summarize_cli_failure(&stderr)
                )));
            }
            Err(e) => {
                return Err(GitServiceError::InvalidRepository(format!(
                    "git rebase failed: {e}"
                )));
            }
        }

        let final_commit = worktree_repo.head()?.peel_to_commit()?;
        Ok(final_commit.id().to_string())
    }

    /// Rebase-back: fast-forward the target branch to the workspace branch.
    pub fn rebase_back(
        &self,
        repo_path: &Path,
        worktree_path: &Path,
        workspace_branch: &str,
        target_branch: &str,
        _commit_message: &str,
    ) -> Result<String, GitServiceError> {
        let worktree_repo = Repository::open(worktree_path)?;

        self.check_worktree_clean(&worktree_repo)?;

        let git = GitCli::new();

        if git.is_rebase_in_progress(worktree_path).unwrap_or(false) {
            return Err(GitServiceError::RebaseInProgress);
        }

        let target_checkout_path = self
            .find_checkout_path_for_branch(repo_path, target_branch)?
            .unwrap_or_else(|| repo_path.to_path_buf());
        let target_repo = Repository::open(&target_checkout_path)?;

        self.check_worktree_clean(&target_repo)?;

        if git
            .is_rebase_in_progress(&target_checkout_path)
            .unwrap_or(false)
        {
            return Err(GitServiceError::RebaseInProgress);
        }

        self.ensure_cli_commit_identity(&target_checkout_path)?;

        let current_branch = git.get_current_branch(&target_checkout_path).map_err(|e| {
            GitServiceError::InvalidRepository(format!("git current-branch failed: {e}"))
        })?;
        if current_branch.trim() != target_branch {
            git.checkout_branch(&target_checkout_path, target_branch)
                .map_err(|e| {
                    GitServiceError::InvalidRepository(format!(
                        "git checkout target branch failed: {e}"
                    ))
                })?;
        }

        let sha = match git.merge_ff_only(&target_checkout_path, workspace_branch) {
            Ok(sha) => sha,
            Err(GitCliError::CommandFailed(stderr)) => {
                let conflicted_files = git
                    .get_conflicted_files(&target_checkout_path)
                    .unwrap_or_default();
                let has_conflict_state = !conflicted_files.is_empty()
                    || git
                        .is_merge_in_progress(&target_checkout_path)
                        .unwrap_or(false);
                let looks_like_conflict =
                    has_conflict_state || Self::looks_like_conflict_text(&stderr);
                if looks_like_conflict {
                    let msg = format!(
                        "Merge conflicts while merging '{}' into '{}'. Resolve conflicts and continue.",
                        workspace_branch, target_branch
                    );
                    return Err(GitServiceError::MergeConflicts {
                        message: msg,
                        conflicted_files,
                    });
                }
                let lowered = stderr.to_lowercase();
                if lowered.contains("not possible to fast-forward")
                    || lowered.contains("non-fast-forward")
                {
                    return Err(GitServiceError::BranchesDiverged(format!(
                        "Cannot fast-forward '{target_branch}' to '{workspace_branch}'. The target branch moved after step 1. Please rerun Rebase Back."
                    )));
                }
                return Err(GitServiceError::InvalidRepository(format!(
                    "Rebase-back failed: {}",
                    Self::summarize_cli_failure(&stderr)
                )));
            }
            Err(e) => {
                return Err(GitServiceError::InvalidRepository(format!(
                    "git fast-forward failed: {e}"
                )));
            }
        };

        Ok(sha)
    }
}
