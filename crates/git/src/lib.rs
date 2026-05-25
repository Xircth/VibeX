use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
};

use chrono::{DateTime, Utc};
use git2::{BranchType, Delta, DiffFindOptions, DiffOptions, Reference, Remote, Repository, Sort};
use utils::diff::{Diff, DiffChangeKind, FileDiffDetails, compute_line_change_counts};

mod cli;
mod panel_ops;
mod types;
mod validation;

use cli::{ChangeType, StatusDiffEntry, StatusDiffOptions};
pub use cli::{GitCli, GitCliError, StatusEntry, WorktreeStatus};
pub use types::*;
pub use utils::path::ALWAYS_SKIP_DIRS;
pub use validation::is_valid_branch_prefix;

/// Service for managing Git operations in task execution workflows
#[derive(Clone)]
pub struct GitService {}

// Max inline diff size for UI (in bytes). Files larger than this will have
// their contents omitted from the diff stream to avoid UI crashes.
const MAX_INLINE_DIFF_BYTES: usize = 2 * 1024 * 1024; // ~2MB

impl Default for GitService {
    fn default() -> Self {
        Self::new()
    }
}

impl GitService {
    fn canonicalize_path_for_compare(path: &Path) -> PathBuf {
        let normalized = utils::path::normalize_macos_private_alias(path);
        std::fs::canonicalize(&normalized).unwrap_or(normalized)
    }

    fn summarize_cli_failure(output: &str) -> String {
        output
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty() && !line.starts_with("--- "))
            .unwrap_or("Command failed with no output")
            .to_string()
    }

    fn looks_like_conflict_text(output: &str) -> bool {
        let lowered = output.to_lowercase();
        output.contains("CONFLICT")
            || output.contains("Automatic merge failed")
            || output.contains("could not apply")
            || lowered.contains("resolve all conflicts")
            || lowered.contains("merge conflict")
    }

    /// Create a new GitService for the given repository path
    pub fn new() -> Self {
        Self {}
    }

    pub fn is_branch_name_valid(&self, name: &str) -> bool {
        git2::Branch::name_is_valid(name).unwrap_or(false)
    }

    /// Open the repository
    pub fn open_repo(&self, repo_path: &Path) -> Result<Repository, GitServiceError> {
        Repository::open(repo_path).map_err(GitServiceError::from)
    }

    /// Ensure local (repo-scoped) identity exists for CLI commits.
    /// Sets user.name/email only if missing in the repo config.
    fn ensure_cli_commit_identity(&self, repo_path: &Path) -> Result<(), GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        let cfg = repo.config()?;
        let has_name = cfg.get_string("user.name").is_ok();
        let has_email = cfg.get_string("user.email").is_ok();
        if !(has_name && has_email) {
            let mut cfg = repo.config()?;
            cfg.set_str("user.name", "VibeX")?;
            cfg.set_str("user.email", "noreply@vibex.com")?;
        }
        Ok(())
    }

    /// Get a signature for libgit2 commits with a safe fallback identity.
    fn signature_with_fallback<'a>(
        &self,
        repo: &'a Repository,
    ) -> Result<git2::Signature<'a>, GitServiceError> {
        match repo.signature() {
            Ok(sig) => Ok(sig),
            Err(_) => {
                git2::Signature::now("VibeX", "noreply@vibex.com").map_err(GitServiceError::from)
            }
        }
    }

    fn default_remote(
        &self,
        repo: &Repository,
        repo_path: &Path,
    ) -> Result<GitRemote, GitServiceError> {
        let mut remotes = GitCli::new().list_remotes(repo_path)?;

        // Check for pushDefault config
        if let Ok(config) = repo.config()
            && let Ok(default_name) = config.get_string("remote.pushDefault")
            && let Some(idx) = remotes.iter().position(|(name, _)| name == &default_name)
        {
            let (name, url) = remotes.swap_remove(idx);
            return Ok(GitRemote { name, url });
        }

        // Fall back to first remote
        remotes
            .into_iter()
            .next()
            .map(|(name, url)| GitRemote { name, url })
            .ok_or_else(|| GitServiceError::InvalidRepository("No remotes configured".to_string()))
    }

    /// Initialize a new git repository with a main branch and initial commit
    pub fn initialize_repo_with_main_branch(
        &self,
        repo_path: &Path,
    ) -> Result<(), GitServiceError> {
        // Create directory if it doesn't exist
        if !repo_path.exists() {
            std::fs::create_dir_all(repo_path)?;
        }

        // Initialize git repository with main branch
        let repo = Repository::init_opts(
            repo_path,
            git2::RepositoryInitOptions::new()
                .initial_head("main")
                .mkdir(true),
        )?;

        // Create initial commit
        self.create_initial_commit(&repo)?;

        Ok(())
    }

    /// Ensure an existing repository has a main branch (for empty repos)
    pub fn ensure_main_branch_exists(&self, repo_path: &Path) -> Result<(), GitServiceError> {
        let repo = self.open_repo(repo_path)?;

        match repo.branches(None) {
            Ok(branches) => {
                if branches.count() == 0 {
                    // No branches exist - create initial commit on main branch
                    self.create_initial_commit(&repo)?;
                }
            }
            Err(e) => {
                return Err(GitServiceError::InvalidRepository(format!(
                    "Failed to list branches: {e}"
                )));
            }
        }
        Ok(())
    }

    pub fn create_initial_commit(&self, repo: &Repository) -> Result<(), GitServiceError> {
        let signature = self.signature_with_fallback(repo)?;

        let tree_id = {
            let tree_builder = repo.treebuilder(None)?;
            tree_builder.write()?
        };
        let tree = repo.find_tree(tree_id)?;

        // Create initial commit on main branch
        let _commit_id = repo.commit(
            Some("refs/heads/main"),
            &signature,
            &signature,
            "Initial commit",
            &tree,
            &[],
        )?;

        // Set HEAD to point to main branch
        repo.set_head("refs/heads/main")?;

        Ok(())
    }

    pub fn commit(&self, path: &Path, message: &str) -> Result<bool, GitServiceError> {
        // Use Git CLI to respect sparse-checkout semantics for staging and commit
        let git = GitCli::new();
        let has_changes = git
            .has_changes(path)
            .map_err(|e| GitServiceError::InvalidRepository(format!("git status failed: {e}")))?;
        if !has_changes {
            tracing::debug!("No changes to commit!");
            return Ok(false);
        }

        git.add_all(path)
            .map_err(|e| GitServiceError::InvalidRepository(format!("git add failed: {e}")))?;
        // Only ensure identity once we know we're about to commit
        self.ensure_cli_commit_identity(path)?;
        git.commit(path, message)
            .map_err(|e| GitServiceError::InvalidRepository(format!("git commit failed: {e}")))?;
        Ok(true)
    }

    /// Get diffs between branches or worktree changes
    pub fn get_diffs(
        &self,
        target: DiffTarget,
        path_filter: Option<&[&str]>,
    ) -> Result<Vec<Diff>, GitServiceError> {
        match target {
            DiffTarget::Worktree {
                worktree_path,
                base_commit,
            } => {
                // Use Git CLI to compute diff vs base to avoid sparse false deletions
                let repo = Repository::open(worktree_path)?;
                let base_tree = repo
                    .find_commit(base_commit.as_oid())?
                    .tree()
                    .map_err(|e| {
                        GitServiceError::InvalidRepository(format!(
                            "Failed to find base commit tree: {e}"
                        ))
                    })?;

                let git = GitCli::new();
                let cli_opts = StatusDiffOptions {
                    path_filter: path_filter.map(|fs| fs.iter().map(|s| s.to_string()).collect()),
                };
                let entries = git
                    .diff_status(worktree_path, base_commit, cli_opts)
                    .map_err(|e| {
                        GitServiceError::InvalidRepository(format!("git diff failed: {e}"))
                    })?;
                Ok(entries
                    .into_iter()
                    .map(|e| Self::status_entry_to_diff(&repo, &base_tree, e))
                    .collect())
            }
            DiffTarget::Branch {
                repo_path,
                branch_name,
                base_branch,
            } => {
                let repo = self.open_repo(repo_path)?;
                let base_tree = Self::find_branch(&repo, base_branch)?
                    .get()
                    .peel_to_commit()?
                    .tree()?;
                let branch_tree = Self::find_branch(&repo, branch_name)?
                    .get()
                    .peel_to_commit()?
                    .tree()?;

                let mut diff_opts = DiffOptions::new();
                diff_opts.include_typechange(true);

                // Add path filtering if specified
                if let Some(paths) = path_filter {
                    for path in paths {
                        diff_opts.pathspec(*path);
                    }
                }

                let mut diff = repo.diff_tree_to_tree(
                    Some(&base_tree),
                    Some(&branch_tree),
                    Some(&mut diff_opts),
                )?;

                // Enable rename detection
                let mut find_opts = DiffFindOptions::new();
                diff.find_similar(Some(&mut find_opts))?;

                self.convert_diff_to_file_diffs(diff, &repo)
            }
            DiffTarget::Commit {
                repo_path,
                commit_sha,
            } => {
                let repo = self.open_repo(repo_path)?;

                // Resolve commit and its baseline (the parent before the squash landed)
                let commit_oid = git2::Oid::from_str(commit_sha).map_err(|_| {
                    GitServiceError::InvalidRepository(format!("Invalid commit SHA: {commit_sha}"))
                })?;
                let commit = repo.find_commit(commit_oid)?;
                let parent = commit.parent(0).map_err(|_| {
                    GitServiceError::InvalidRepository(
                        "Commit has no parent; cannot diff a squash merge without a baseline"
                            .into(),
                    )
                })?;

                let parent_tree = parent.tree()?;
                let commit_tree = commit.tree()?;

                // Diff options
                let mut diff_opts = git2::DiffOptions::new();
                diff_opts.include_typechange(true);

                // Optional path filtering
                if let Some(paths) = path_filter {
                    for path in paths {
                        diff_opts.pathspec(*path);
                    }
                }

                // Compute the diff parent -> commit
                let mut diff = repo.diff_tree_to_tree(
                    Some(&parent_tree),
                    Some(&commit_tree),
                    Some(&mut diff_opts),
                )?;

                // Enable rename detection
                let mut find_opts = git2::DiffFindOptions::new();
                diff.find_similar(Some(&mut find_opts))?;

                self.convert_diff_to_file_diffs(diff, &repo)
            }
        }
    }

    /// Convert git2::Diff to our Diff structs
    fn convert_diff_to_file_diffs(
        &self,
        diff: git2::Diff,
        repo: &Repository,
    ) -> Result<Vec<Diff>, GitServiceError> {
        let mut file_diffs = Vec::new();

        let mut delta_index: usize = 0;
        diff.foreach(
            &mut |delta, _| {
                if delta.status() == Delta::Unreadable {
                    return true;
                }

                let status = delta.status();

                // Decide if we should omit content due to size
                let mut content_omitted = false;
                // Check old blob size when applicable
                if !matches!(status, Delta::Added) {
                    let oid = delta.old_file().id();
                    if !oid.is_zero()
                        && let Ok(blob) = repo.find_blob(oid)
                        && !blob.is_binary()
                        && blob.size() > MAX_INLINE_DIFF_BYTES
                    {
                        content_omitted = true;
                    }
                }
                // Check new blob size when applicable
                if !matches!(status, Delta::Deleted) {
                    let oid = delta.new_file().id();
                    if !oid.is_zero()
                        && let Ok(blob) = repo.find_blob(oid)
                        && !blob.is_binary()
                        && blob.size() > MAX_INLINE_DIFF_BYTES
                    {
                        content_omitted = true;
                    }
                }

                // Only build old/new content if not omitted
                let (old_path, old_content) = if matches!(status, Delta::Added) {
                    (None, None)
                } else {
                    let path_opt = delta
                        .old_file()
                        .path()
                        .map(|p| p.to_string_lossy().to_string());
                    if content_omitted {
                        (path_opt, None)
                    } else {
                        let details = delta
                            .old_file()
                            .path()
                            .map(|p| self.create_file_details(p, &delta.old_file().id(), repo));
                        (
                            details.as_ref().and_then(|f| f.file_name.clone()),
                            details.and_then(|f| f.content),
                        )
                    }
                };

                let (new_path, new_content) = if matches!(status, Delta::Deleted) {
                    (None, None)
                } else {
                    let path_opt = delta
                        .new_file()
                        .path()
                        .map(|p| p.to_string_lossy().to_string());
                    if content_omitted {
                        (path_opt, None)
                    } else {
                        let details = delta
                            .new_file()
                            .path()
                            .map(|p| self.create_file_details(p, &delta.new_file().id(), repo));
                        (
                            details.as_ref().and_then(|f| f.file_name.clone()),
                            details.and_then(|f| f.content),
                        )
                    }
                };

                let mut change = match status {
                    Delta::Added => DiffChangeKind::Added,
                    Delta::Deleted => DiffChangeKind::Deleted,
                    Delta::Modified => DiffChangeKind::Modified,
                    Delta::Renamed => DiffChangeKind::Renamed,
                    Delta::Copied => DiffChangeKind::Copied,
                    Delta::Untracked => DiffChangeKind::Added,
                    _ => DiffChangeKind::Modified,
                };

                // Detect pure mode changes (e.g., chmod +/-x) and classify as PermissionChange
                if matches!(status, Delta::Modified)
                    && delta.old_file().mode() != delta.new_file().mode()
                {
                    // Only downgrade to PermissionChange if we KNOW content is unchanged
                    if old_content.is_some() && new_content.is_some() && old_content == new_content
                    {
                        change = DiffChangeKind::PermissionChange;
                    }
                }

                // Always compute line stats via libgit2 Patch
                let (additions, deletions) = if let Ok(Some(patch)) =
                    git2::Patch::from_diff(&diff, delta_index)
                    && let Ok((_ctx, adds, dels)) = patch.line_stats()
                {
                    (Some(adds), Some(dels))
                } else {
                    (None, None)
                };

                file_diffs.push(Diff {
                    change,
                    old_path,
                    new_path,
                    old_content,
                    new_content,
                    content_omitted,
                    additions,
                    deletions,
                    repo_id: None,
                });

                delta_index += 1;
                true
            },
            None,
            None,
            None,
        )?;

        Ok(file_diffs)
    }

    /// Extract file path from a Diff (for indexing and ConversationPatch)
    pub fn diff_path(diff: &Diff) -> String {
        diff.new_path
            .clone()
            .or_else(|| diff.old_path.clone())
            .unwrap_or_default()
    }

    /// Helper function to convert blob to string content
    fn blob_to_string(blob: &git2::Blob) -> Option<String> {
        if blob.is_binary() {
            None // Skip binary files
        } else {
            std::str::from_utf8(blob.content())
                .ok()
                .map(|s| s.to_string())
        }
    }

    /// Helper function to read file content from filesystem with safety guards
    pub(crate) fn read_file_to_string(repo: &Repository, rel_path: &Path) -> Option<String> {
        let workdir = repo.workdir()?;
        let abs_path = workdir.join(rel_path);

        // Read file from filesystem
        let bytes = match std::fs::read(&abs_path) {
            Ok(bytes) => bytes,
            Err(e) => {
                tracing::debug!("Failed to read file from filesystem: {:?}: {}", abs_path, e);
                return None;
            }
        };

        // Size guard - skip files larger than UI inline threshold
        if bytes.len() > MAX_INLINE_DIFF_BYTES {
            tracing::debug!(
                "Skipping large file ({}KB): {:?}",
                bytes.len() / 1024,
                abs_path
            );
            return None;
        }

        // Binary guard - skip files containing null bytes
        if bytes.contains(&0) {
            tracing::debug!("Skipping binary file: {:?}", abs_path);
            return None;
        }

        // UTF-8 validation
        match String::from_utf8(bytes) {
            Ok(content) => Some(content),
            Err(e) => {
                tracing::debug!("File is not valid UTF-8: {:?}: {}", abs_path, e);
                None
            }
        }
    }

    /// Create FileDiffDetails from path and blob with filesystem fallback
    fn create_file_details(
        &self,
        path: &Path,
        blob_id: &git2::Oid,
        repo: &Repository,
    ) -> FileDiffDetails {
        let file_name = path.to_string_lossy().to_string();

        // Try to get content from blob first (for non-zero OIDs)
        let content = if !blob_id.is_zero() {
            repo.find_blob(*blob_id)
                .ok()
                .and_then(|blob| Self::blob_to_string(&blob))
                .or_else(|| {
                    // Fallback to filesystem for unstaged changes
                    tracing::debug!(
                        "Blob not found for non-zero OID, reading from filesystem: {}",
                        file_name
                    );
                    Self::read_file_to_string(repo, path)
                })
        } else {
            // For zero OIDs, check filesystem directly (covers new/untracked files)
            Self::read_file_to_string(repo, path)
        };

        FileDiffDetails {
            file_name: Some(file_name),
            content,
        }
    }

    /// Create Diff entries from git_cli::StatusDiffEntry
    /// New Diff format is flattened with change kind, paths, and optional contents.
    fn status_entry_to_diff(repo: &Repository, base_tree: &git2::Tree, e: StatusDiffEntry) -> Diff {
        // Map ChangeType to DiffChangeKind
        let mut change = match e.change {
            ChangeType::Added => DiffChangeKind::Added,
            ChangeType::Deleted => DiffChangeKind::Deleted,
            ChangeType::Modified => DiffChangeKind::Modified,
            ChangeType::Renamed => DiffChangeKind::Renamed,
            ChangeType::Copied => DiffChangeKind::Copied,
            // Treat type changes and unmerged as modified for now
            ChangeType::TypeChanged | ChangeType::Unmerged => DiffChangeKind::Modified,
            ChangeType::Unknown(_) => DiffChangeKind::Modified,
        };

        // Determine old/new paths based on change
        let (old_path_opt, new_path_opt): (Option<String>, Option<String>) = match e.change {
            ChangeType::Added => (None, Some(e.path.clone())),
            ChangeType::Deleted => (Some(e.old_path.unwrap_or(e.path.clone())), None),
            ChangeType::Modified | ChangeType::TypeChanged | ChangeType::Unmerged => (
                Some(e.old_path.unwrap_or(e.path.clone())),
                Some(e.path.clone()),
            ),
            ChangeType::Renamed | ChangeType::Copied => (e.old_path.clone(), Some(e.path.clone())),
            ChangeType::Unknown(_) => (e.old_path.clone(), Some(e.path.clone())),
        };

        // Decide if we should omit content by size (either side)
        let mut content_omitted = false;
        // Old side (from base tree)
        if let Some(ref oldp) = old_path_opt {
            let rel = std::path::Path::new(oldp);
            if let Ok(entry) = base_tree.get_path(rel)
                && entry.kind() == Some(git2::ObjectType::Blob)
                && let Ok(blob) = repo.find_blob(entry.id())
                && !blob.is_binary()
                && blob.size() > MAX_INLINE_DIFF_BYTES
            {
                content_omitted = true;
            }
        }
        // New side (from filesystem)
        if let Some(ref newp) = new_path_opt
            && let Some(workdir) = repo.workdir()
        {
            let abs = workdir.join(newp);
            if let Ok(md) = std::fs::metadata(&abs)
                && (md.len() as usize) > MAX_INLINE_DIFF_BYTES
            {
                content_omitted = true;
            }
        }

        // Load contents only if not omitted
        let (old_content, new_content) = if content_omitted {
            (None, None)
        } else {
            // Load old content from base tree if possible
            let old_content = if let Some(ref oldp) = old_path_opt {
                let rel = std::path::Path::new(oldp);
                match base_tree.get_path(rel) {
                    Ok(entry) if entry.kind() == Some(git2::ObjectType::Blob) => repo
                        .find_blob(entry.id())
                        .ok()
                        .and_then(|b| Self::blob_to_string(&b)),
                    _ => None,
                }
            } else {
                None
            };

            // Load new content from filesystem (worktree) when available
            let new_content = if let Some(ref newp) = new_path_opt {
                let rel = std::path::Path::new(newp);
                Self::read_file_to_string(repo, rel)
            } else {
                None
            };
            (old_content, new_content)
        };

        // If reported as Modified but content is identical, treat as a permission-only change
        if matches!(change, DiffChangeKind::Modified)
            && old_content.is_some()
            && new_content.is_some()
            && old_content == new_content
        {
            change = DiffChangeKind::PermissionChange;
        }

        // Compute line stats from available content
        let (additions, deletions) = match (&old_content, &new_content) {
            (Some(old), Some(new)) => {
                let (adds, dels) = compute_line_change_counts(old, new);
                (Some(adds), Some(dels))
            }
            (Some(old), None) => {
                // File deleted - all lines are deletions
                (Some(0), Some(old.lines().count()))
            }
            (None, Some(new)) => {
                // File added - all lines are additions
                (Some(new.lines().count()), Some(0))
            }
            (None, None) => (None, None),
        };

        Diff {
            change,
            old_path: old_path_opt,
            new_path: new_path_opt,
            old_content,
            new_content,
            content_omitted,
            additions,
            deletions,
            repo_id: None,
        }
    }

    /// Find where a branch is currently checked out
    fn find_checkout_path_for_branch(
        &self,
        repo_path: &Path,
        branch_name: &str,
    ) -> Result<Option<std::path::PathBuf>, GitServiceError> {
        let git_cli = GitCli::new();
        let worktrees = git_cli.list_worktrees(repo_path).map_err(|e| {
            GitServiceError::InvalidRepository(format!("git worktree list failed: {e}"))
        })?;

        for worktree in worktrees {
            if let Some(ref branch) = worktree.branch
                && branch == branch_name
            {
                return Ok(Some(std::path::PathBuf::from(worktree.path)));
            }
        }
        Ok(None)
    }

    /// Find the local worktree path where a branch is currently checked out.
    pub fn find_worktree_path_for_branch(
        &self,
        repo_path: &Path,
        branch_name: &str,
    ) -> Result<Option<std::path::PathBuf>, GitServiceError> {
        self.find_checkout_path_for_branch(repo_path, branch_name)
    }

    /// Merge changes from a task branch into the base branch.
    pub fn merge_changes(
        &self,
        base_worktree_path: &Path,
        task_worktree_path: &Path,
        task_branch_name: &str,
        base_branch_name: &str,
        commit_message: &str,
    ) -> Result<String, GitServiceError> {
        // Open the repositories
        let task_repo = self.open_repo(task_worktree_path)?;
        let base_repo = self.open_repo(base_worktree_path)?;

        // Check if base branch is ahead of task branch - this indicates the base has moved
        // ahead since the task was created, which should block the merge
        let (_, task_behind) =
            self.get_branch_status(base_worktree_path, task_branch_name, base_branch_name)?;

        if task_behind > 0 {
            return Err(GitServiceError::BranchesDiverged(format!(
                "Cannot merge: base branch '{base_branch_name}' is {task_behind} commits ahead of task branch '{task_branch_name}'. The base branch has moved forward since the task was created.",
            )));
        }

        // Check where base branch is checked out (if anywhere)
        match self.find_checkout_path_for_branch(base_worktree_path, base_branch_name)? {
            Some(base_checkout_path) => {
                // base branch is checked out somewhere - use CLI merge
                let git_cli = GitCli::new();

                // Safety check: base branch has no staged changes
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

                // Use CLI merge in base context
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

                // Update task branch ref for continuity
                let task_refname = format!("refs/heads/{task_branch_name}");
                git_cli
                    .update_ref(base_worktree_path, &task_refname, &sha)
                    .map_err(|e| {
                        GitServiceError::InvalidRepository(format!("git update-ref failed: {e}"))
                    })?;

                Ok(sha)
            }
            None => {
                // base branch not checked out anywhere - use libgit2 pure ref operations
                let task_branch = Self::find_branch(&task_repo, task_branch_name)?;
                let base_branch = Self::find_branch(&task_repo, base_branch_name)?;

                // Resolve commits
                let base_commit = base_branch.get().peel_to_commit()?;
                let task_commit = task_branch.get().peel_to_commit()?;

                // Create the squash commit in-memory (no checkout) and update the base branch ref
                let signature = self.signature_with_fallback(&task_repo)?;
                let squash_commit_id = self.perform_squash_merge(
                    &task_repo,
                    &base_commit,
                    &task_commit,
                    &signature,
                    commit_message,
                    base_branch_name,
                )?;

                // Update the task branch to the new squash commit so follow-up
                // work can continue from the merged state without conflicts.
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
    fn get_branch_status_inner(
        &self,
        repo: &Repository,
        branch_ref: &Reference,
        base_branch_ref: &Reference,
    ) -> Result<(usize, usize), GitServiceError> {
        let (a, b) = repo.graph_ahead_behind(
            branch_ref.target().ok_or(GitServiceError::BranchNotFound(
                "Branch not found".to_string(),
            ))?,
            base_branch_ref
                .target()
                .ok_or(GitServiceError::BranchNotFound(
                    "Branch not found".to_string(),
                ))?,
        )?;
        Ok((a, b))
    }

    pub fn get_branch_status(
        &self,
        repo_path: &Path,
        branch_name: &str,
        base_branch_name: &str,
    ) -> Result<(usize, usize), GitServiceError> {
        let repo = Repository::open(repo_path)?;
        let branch = Self::find_branch(&repo, branch_name)?;
        let base_branch = Self::find_branch(&repo, base_branch_name)?;
        self.get_branch_status_inner(
            &repo,
            &branch.into_reference(),
            &base_branch.into_reference(),
        )
    }

    /// Collect commit messages from `branch_name` that are ahead of `base_branch_name`.
    /// Returns messages in chronological order (oldest first).
    pub fn get_branch_commit_messages(
        &self,
        repo_path: &Path,
        branch_name: &str,
        base_branch_name: &str,
    ) -> Result<Vec<String>, GitServiceError> {
        let repo = Repository::open(repo_path)?;
        let branch = Self::find_branch(&repo, branch_name)?;
        let base_branch = Self::find_branch(&repo, base_branch_name)?;

        let branch_oid = branch.get().peel_to_commit()?.id();
        let base_oid = base_branch.get().peel_to_commit()?.id();

        let mut revwalk = repo.revwalk()?;
        revwalk.push(branch_oid)?;
        revwalk.hide(base_oid)?;
        revwalk.set_sorting(git2::Sort::TIME | git2::Sort::REVERSE)?;

        let mut messages = Vec::new();
        for oid_result in revwalk {
            let oid = oid_result?;
            if let Ok(commit) = repo.find_commit(oid)
                && let Some(msg) = commit.message()
            {
                let trimmed = msg.trim();
                if !trimmed.is_empty() {
                    messages.push(trimmed.to_string());
                }
            }
        }

        Ok(messages)
    }

    /// Get the full commit graph for two branches.
    ///
    /// Returns commits from both branches starting from their tips down to
    /// a configurable depth past the merge base, or max_commits total.
    /// Commits are ordered newest-first.
    pub fn get_commit_graph(
        &self,
        repo_path: &Path,
        branch_name: &str,
        base_branch_name: &str,
        max_commits: usize,
    ) -> Result<CommitGraph, GitServiceError> {
        let repo = Repository::open(repo_path)?;
        let branch = Self::find_branch(&repo, branch_name)?;
        let base_branch = Self::find_branch(&repo, base_branch_name)?;

        let branch_oid = branch.get().peel_to_commit()?.id();
        let base_oid = base_branch.get().peel_to_commit()?.id();

        // Find merge base
        let merge_base = repo.merge_base(branch_oid, base_oid).ok();

        // Collect all branch refs for labeling
        let mut ref_map: HashMap<git2::Oid, Vec<String>> = HashMap::new();
        if let Ok(branches) = repo.branches(None) {
            for (b, _) in branches.flatten() {
                if let Ok(Some(name)) = b.name()
                    && let Ok(commit) = b.get().peel_to_commit()
                {
                    ref_map
                        .entry(commit.id())
                        .or_default()
                        .push(name.to_string());
                }
            }
        }

        // Collect commits reachable only from branch_name (not from base)
        let branch_only: HashSet<git2::Oid> = {
            let mut rw = repo.revwalk()?;
            rw.push(branch_oid)?;
            rw.hide(base_oid)?;
            rw.filter_map(|r| r.ok()).collect()
        };

        // Revwalk from both branch tips
        let mut revwalk = repo.revwalk()?;
        revwalk.push(branch_oid)?;
        revwalk.push(base_oid)?;
        revwalk.set_sorting(Sort::TIME)?;

        let mut nodes = Vec::new();
        let past_merge_base_limit = 5;
        let mut past_merge_base = 0usize;
        let mut found_merge_base = false;

        for (count, oid_result) in revwalk.enumerate() {
            if count >= max_commits {
                break;
            }
            if found_merge_base && past_merge_base >= past_merge_base_limit {
                break;
            }

            let oid = oid_result?;
            let commit = repo.find_commit(oid)?;

            if merge_base == Some(oid) {
                found_merge_base = true;
            }
            if found_merge_base {
                past_merge_base += 1;
            }

            let hash_str = format!("{}", oid);
            let short_hash = hash_str[..7.min(hash_str.len())].to_string();

            let message = commit
                .message()
                .unwrap_or("")
                .lines()
                .next()
                .unwrap_or("")
                .trim()
                .to_string();

            let author = commit.author().name().unwrap_or("Unknown").to_string();
            let timestamp = commit.time().seconds();

            let parents: Vec<String> = commit.parent_ids().map(|p| format!("{}", p)).collect();

            let refs = ref_map.get(&oid).cloned().unwrap_or_default();
            let is_current_branch = branch_only.contains(&oid);

            nodes.push(CommitGraphNode {
                hash: short_hash,
                full_hash: hash_str,
                message,
                author,
                timestamp,
                parents,
                refs,
                is_current_branch,
            });
        }

        Ok(CommitGraph {
            nodes,
            merge_base: merge_base.map(|o| format!("{}", o)),
            current_branch: branch_name.to_string(),
            target_branch: base_branch_name.to_string(),
        })
    }

    pub fn get_base_commit(
        &self,
        repo_path: &Path,
        branch_name: &str,
        base_branch_name: &str,
    ) -> Result<Commit, GitServiceError> {
        let repo = Repository::open(repo_path)?;
        let branch = Self::find_branch(&repo, branch_name)?;
        let base_branch = Self::find_branch(&repo, base_branch_name)?;
        // Find the common ancestor (merge base)
        let oid = repo
            .merge_base(
                branch.get().peel_to_commit()?.id(),
                base_branch.get().peel_to_commit()?.id(),
            )
            .map_err(GitServiceError::from)?;
        Ok(Commit::new(oid))
    }

    pub fn get_remote_branch_status(
        &self,
        repo_path: &Path,
        branch_name: &str,
        base_branch_name: Option<&str>,
    ) -> Result<(usize, usize), GitServiceError> {
        let repo = Repository::open(repo_path)?;
        let branch_ref = Self::find_branch(&repo, branch_name)?.into_reference();
        // base branch is either given or upstream of branch_name
        let base_branch_ref = if let Some(bn) = base_branch_name {
            Self::find_branch(&repo, bn)?
        } else {
            repo.find_branch(branch_name, BranchType::Local)?
                .upstream()?
        }
        .into_reference();
        let remote = self.get_remote_from_branch_ref(&repo, &base_branch_ref)?;
        self.fetch_all_from_remote(&repo, &remote)?;
        self.get_branch_status_inner(&repo, &branch_ref, &base_branch_ref)
    }

    pub fn is_worktree_clean(&self, worktree_path: &Path) -> Result<bool, GitServiceError> {
        let repo = self.open_repo(worktree_path)?;
        match self.check_worktree_clean(&repo) {
            Ok(()) => Ok(true),
            Err(GitServiceError::WorktreeDirty(_, _)) => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// Check if the worktree is clean (no uncommitted changes to tracked files)
    fn check_worktree_clean(&self, repo: &Repository) -> Result<(), GitServiceError> {
        let mut status_options = git2::StatusOptions::new();
        status_options
            .include_untracked(false) // Don't include untracked files
            .include_ignored(false); // Don't include ignored files

        let statuses = repo.statuses(Some(&mut status_options))?;

        if !statuses.is_empty() {
            let mut dirty_files = Vec::new();
            for entry in statuses.iter() {
                let status = entry.status();
                // Only consider files that are actually tracked and modified
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

    /// Get current HEAD information including branch name and commit OID
    pub fn get_head_info(&self, repo_path: &Path) -> Result<HeadInfo, GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        let head = repo.head()?;

        let branch = if let Some(branch_name) = head.shorthand() {
            branch_name.to_string()
        } else {
            "HEAD".to_string()
        };

        let oid = if let Some(target_oid) = head.target() {
            target_oid.to_string()
        } else {
            // Handle case where HEAD exists but has no target (empty repo)
            return Err(GitServiceError::InvalidRepository(
                "Repository HEAD has no target commit".to_string(),
            ));
        };

        Ok(HeadInfo { branch, oid })
    }

    pub fn get_current_branch(&self, repo_path: &Path) -> Result<String, git2::Error> {
        // Thin wrapper for backward compatibility
        match self.get_head_info(repo_path) {
            Ok(head_info) => Ok(head_info.branch),
            Err(GitServiceError::Git(git_err)) => Err(git_err),
            Err(_) => Err(git2::Error::from_str("Failed to get head info")),
        }
    }

    /// Get the commit OID (as hex string) for a given branch without modifying HEAD
    pub fn get_branch_oid(
        &self,
        repo_path: &Path,
        branch_name: &str,
    ) -> Result<String, GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        let branch = Self::find_branch(&repo, branch_name)?;
        let oid = branch.get().peel_to_commit()?.id().to_string();
        Ok(oid)
    }

    pub fn get_fork_point(
        &self,
        worktree_path: &Path,
        target_branch: &str,
        task_branch: &str,
    ) -> Result<String, GitServiceError> {
        let git = GitCli::new();
        Ok(git.merge_base(worktree_path, target_branch, task_branch)?)
    }

    /// Get the subject/summary line for a given commit OID
    pub fn get_commit_subject(
        &self,
        repo_path: &Path,
        commit_sha: &str,
    ) -> Result<String, GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        let oid = git2::Oid::from_str(commit_sha)
            .map_err(|_| GitServiceError::InvalidRepository("Invalid commit SHA".into()))?;
        let commit = repo.find_commit(oid)?;
        Ok(commit.summary().unwrap_or("(no subject)").to_string())
    }

    /// Compare two OIDs and return (ahead, behind) counts: how many commits
    /// `from_oid` is ahead of and behind `to_oid`.
    pub fn ahead_behind_commits_by_oid(
        &self,
        repo_path: &Path,
        from_oid: &str,
        to_oid: &str,
    ) -> Result<(usize, usize), GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        let from = git2::Oid::from_str(from_oid)
            .map_err(|_| GitServiceError::InvalidRepository("Invalid from OID".into()))?;
        let to = git2::Oid::from_str(to_oid)
            .map_err(|_| GitServiceError::InvalidRepository("Invalid to OID".into()))?;
        let (ahead, behind) = repo.graph_ahead_behind(from, to)?;
        Ok((ahead, behind))
    }

    /// Return the full worktree status including all entries
    pub fn get_worktree_status(
        &self,
        worktree_path: &Path,
    ) -> Result<WorktreeStatus, GitServiceError> {
        let cli = GitCli::new();
        cli.get_worktree_status(worktree_path)
            .map_err(|e| GitServiceError::InvalidRepository(format!("git status failed: {e}")))
    }

    /// Return (uncommitted_tracked_changes, untracked_files) counts in worktree
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
            // Avoid clobbering uncommitted changes unless explicitly forced
            self.check_worktree_clean(&repo)?;
        }
        let cli = GitCli::new();
        cli.git(worktree_path, ["reset", "--hard", commit_sha])
            .map_err(|e| {
                GitServiceError::InvalidRepository(format!("git reset --hard failed: {e}"))
            })?;
        // Reapply sparse-checkout if configured (non-fatal)
        let _ = cli.git(worktree_path, ["sparse-checkout", "reapply"]);
        Ok(())
    }

    /// Add a worktree for a branch, optionally creating the branch
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

    /// Remove a worktree
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

    /// Move a worktree to a new location
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

    pub fn delete_branch(
        &self,
        repo_path: &Path,
        branch_name: &str,
    ) -> Result<(), GitServiceError> {
        let git = GitCli::new();
        git.delete_branch(repo_path, branch_name)
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

        // Helper function to get last commit date for a branch
        let get_last_commit_date = |branch: &git2::Branch| -> Result<DateTime<Utc>, git2::Error> {
            if let Some(target) = branch.get().target()
                && let Ok(commit) = repo.find_commit(target)
            {
                let timestamp = commit.time().seconds();
                return Ok(DateTime::from_timestamp(timestamp, 0).unwrap_or_else(Utc::now));
            }
            Ok(Utc::now()) // Default to now if we can't get the commit date
        };

        // Get local branches
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

        // Get remote branches
        let remote_branches = repo.branches(Some(BranchType::Remote))?;
        for branch_result in remote_branches {
            let (branch, _) = branch_result?;
            if let Some(name) = branch.name()? {
                // Skip remote HEAD references
                if !name.ends_with("/HEAD") {
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
        }

        // Sort branches: current first, then by most recent commit date
        branches.sort_by(|a, b| {
            if a.is_current && !b.is_current {
                std::cmp::Ordering::Less
            } else if !a.is_current && b.is_current {
                std::cmp::Ordering::Greater
            } else {
                // Sort by most recent commit date (newest first)
                b.last_commit_date.cmp(&a.last_commit_date)
            }
        });

        Ok(branches)
    }

    /// Perform a squash merge of task branch into base branch, but fail on conflicts
    fn perform_squash_merge(
        &self,
        repo: &Repository,
        base_commit: &git2::Commit,
        task_commit: &git2::Commit,
        signature: &git2::Signature,
        commit_message: &str,
        base_branch_name: &str,
    ) -> Result<git2::Oid, GitServiceError> {
        // In-memory merge to detect conflicts without touching the working tree
        let mut merge_opts = git2::MergeOptions::new();
        // Safety and correctness options
        merge_opts.find_renames(true); // improve rename handling
        merge_opts.fail_on_conflict(true); // bail out instead of generating conflicted index
        let mut index = repo.merge_commits(base_commit, task_commit, Some(&merge_opts))?;

        // If there are conflicts, return an error
        if index.has_conflicts() {
            return Err(GitServiceError::MergeConflicts {
                message: "Merge failed due to conflicts. Please resolve conflicts manually."
                    .to_string(),
                conflicted_files: vec![],
            });
        }

        // Write the merged tree back to the repository
        let tree_id = index.write_tree_to(repo)?;
        let tree = repo.find_tree(tree_id)?;

        // Create a squash commit: use merged tree with base_commit as sole parent
        let squash_commit_id = repo.commit(
            None,           // Don't update any reference yet
            signature,      // Author
            signature,      // Committer
            commit_message, // Custom message
            &tree,          // Merged tree content
            &[base_commit], // Single parent: base branch commit
        )?;

        // Update the base branch reference to point to the new commit
        let refname = format!("refs/heads/{base_branch_name}");
        repo.reference(&refname, squash_commit_id, true, "Squash merge")?;

        Ok(squash_commit_id)
    }

    /// Rebase a worktree branch onto a new base
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

        // Safety guard: never operate on a dirty worktree. This preserves any
        // uncommitted changes to tracked files by failing fast instead of
        // resetting or cherry-picking over them. Untracked files are allowed.
        self.check_worktree_clean(&worktree_repo)?;

        // If a rebase is already in progress, refuse to proceed instead of
        // aborting (which might destroy user changes mid-rebase).
        let git = GitCli::new();
        if git.is_rebase_in_progress(worktree_path).unwrap_or(false) {
            return Err(GitServiceError::RebaseInProgress);
        }

        // Get the target base branch reference
        let nbr = Self::find_branch(&main_repo, new_base_branch)?.into_reference();
        // If the target base is remote, update it first so CLI sees latest
        if nbr.is_remote() {
            self.fetch_branch_from_remote(&main_repo, &nbr)?;
        }

        // Ensure identity for any commits produced by rebase
        self.ensure_cli_commit_identity(worktree_path)?;
        // Use git CLI rebase to carry out the operation safely
        match git.rebase_onto(worktree_path, new_base_branch, old_base_branch, task_branch) {
            Ok(()) => {}
            Err(GitCliError::RebaseInProgress) => {
                return Err(GitServiceError::RebaseInProgress);
            }
            Err(GitCliError::CommandFailed(stderr)) => {
                // Prefer state-based conflict detection so locale/CLI formatting differences
                // do not hide merge conflicts from the caller.
                let conflicted_files = git.get_conflicted_files(worktree_path).unwrap_or_default();
                let has_conflict_state = !conflicted_files.is_empty()
                    || git.is_rebase_in_progress(worktree_path).unwrap_or(false);
                let looks_like_conflict =
                    has_conflict_state || Self::looks_like_conflict_text(&stderr);
                if looks_like_conflict {
                    // Determine current attempt branch name for clarity
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

        // Return resulting HEAD commit
        let final_commit = worktree_repo.head()?.peel_to_commit()?;
        Ok(final_commit.id().to_string())
    }

    /// Rebase-back: merge the workspace (AI) branch changes back onto the target branch.
    /// This is the reverse of `rebase_branch` - instead of updating the AI branch with
    /// target branch changes, it pushes AI branch changes into the target branch.
    ///
    /// Steps:
    /// 1. Verify worktree is clean
    /// 2. Checkout target_branch in the worktree
    /// 3. Fast-forward or merge the workspace branch
    /// 4. Checkout back to the workspace branch
    pub fn rebase_back(
        &self,
        repo_path: &Path,
        worktree_path: &Path,
        workspace_branch: &str,
        target_branch: &str,
        _commit_message: &str,
    ) -> Result<String, GitServiceError> {
        let worktree_repo = Repository::open(worktree_path)?;

        // Safety guard: worktree must be clean
        self.check_worktree_clean(&worktree_repo)?;

        let git = GitCli::new();

        // Refuse if rebase is in progress
        if git.is_rebase_in_progress(worktree_path).unwrap_or(false) {
            return Err(GitServiceError::RebaseInProgress);
        }

        // Rebase-back step 2 should happen in the target branch checkout context
        // (typically the project main directory), not in the attempt worktree.
        let target_checkout_path = self
            .find_checkout_path_for_branch(repo_path, target_branch)?
            .unwrap_or_else(|| repo_path.to_path_buf());
        let target_repo = Repository::open(&target_checkout_path)?;

        // Safety guard for target checkout worktree as well.
        self.check_worktree_clean(&target_repo)?;

        if git
            .is_rebase_in_progress(&target_checkout_path)
            .unwrap_or(false)
        {
            return Err(GitServiceError::RebaseInProgress);
        }

        // Ensure identity for any commits produced in target checkout context.
        self.ensure_cli_commit_identity(&target_checkout_path)?;

        // Ensure target branch is checked out in target checkout context.
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

        // Fast-forward target branch to workspace branch. Step 1 already rebases
        // workspace onto target, so this should not produce conflicts.
        let sha = match git.merge_ff_only(&target_checkout_path, workspace_branch) {
            Ok(sha) => sha,
            Err(GitCliError::CommandFailed(stderr)) => {
                // Prefer state-based conflict detection so locale/CLI formatting differences
                // do not hide merge conflicts from the caller.
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

    pub fn find_branch_type(
        &self,
        repo_path: &Path,
        branch_name: &str,
    ) -> Result<BranchType, GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        // Try to find the branch as a local branch first
        match repo.find_branch(branch_name, BranchType::Local) {
            Ok(_) => Ok(BranchType::Local),
            Err(_) => {
                // If not found, try to find it as a remote branch
                match repo.find_branch(branch_name, BranchType::Remote) {
                    Ok(_) => Ok(BranchType::Remote),
                    Err(_) => Err(GitServiceError::BranchNotFound(branch_name.to_string())),
                }
            }
        }
    }

    pub fn check_branch_exists(
        &self,
        repo_path: &Path,
        branch_name: &str,
    ) -> Result<bool, GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        match repo.find_branch(branch_name, BranchType::Local) {
            Ok(_) => Ok(true),
            Err(_) => match repo.find_branch(branch_name, BranchType::Remote) {
                Ok(_) => Ok(true),
                Err(_) => Ok(false),
            },
        }
    }

    pub fn rename_local_branch(
        &self,
        worktree_path: &Path,
        old_branch_name: &str,
        new_branch_name: &str,
    ) -> Result<(), GitServiceError> {
        let repo = self.open_repo(worktree_path)?;

        let mut branch = repo
            .find_branch(old_branch_name, BranchType::Local)
            .map_err(|_| GitServiceError::BranchNotFound(old_branch_name.to_string()))?;

        branch.rename(new_branch_name, false)?;

        repo.set_head(&format!("refs/heads/{new_branch_name}"))?;

        Ok(())
    }

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
            // If there are no conflicted files, prefer `git rebase --quit` to clean up metadata
            let has_conflicts = !self
                .get_conflicted_files(worktree_path)
                .unwrap_or_default()
                .is_empty();
            if has_conflicts {
                return self.abort_rebase(worktree_path);
            } else {
                return git.quit_rebase(worktree_path).map_err(|e| {
                    GitServiceError::InvalidRepository(format!("git rebase --quit failed: {e}"))
                });
            }
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

    pub fn find_branch<'a>(
        repo: &'a Repository,
        branch_name: &str,
    ) -> Result<git2::Branch<'a>, GitServiceError> {
        // Try to find the branch as a local branch first
        match repo.find_branch(branch_name, BranchType::Local) {
            Ok(branch) => Ok(branch),
            Err(_) => {
                // If not found, try to find it as a remote branch
                match repo.find_branch(branch_name, BranchType::Remote) {
                    Ok(branch) => Ok(branch),
                    Err(_) => Err(GitServiceError::BranchNotFound(branch_name.to_string())),
                }
            }
        }
    }

    pub fn get_remote_from_branch_name(
        &self,
        repo_path: &Path,
        branch_name: &str,
    ) -> Result<GitRemote, GitServiceError> {
        let repo = Repository::open(repo_path)?;
        let branch_ref = Self::find_branch(&repo, branch_name)?.into_reference();
        let remote = self.get_remote_from_branch_ref(&repo, &branch_ref)?;
        let name = remote.name().map(|name| name.to_string()).ok_or_else(|| {
            GitServiceError::InvalidRepository(format!(
                "Remote for branch '{branch_name}' has no name"
            ))
        })?;
        let url = remote.url().map(|url| url.to_string()).ok_or_else(|| {
            GitServiceError::InvalidRepository(format!(
                "Remote for branch '{branch_name}' has no URL"
            ))
        })?;
        Ok(GitRemote { name, url })
    }

    pub fn get_remote_url(
        &self,
        repo_path: &Path,
        remote_name: &str,
    ) -> Result<String, GitServiceError> {
        let cli = GitCli::new();
        cli.get_remote_url(repo_path, remote_name)
            .map_err(GitServiceError::from)
    }

    pub fn get_default_remote(&self, repo_path: &Path) -> Result<GitRemote, GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        self.default_remote(&repo, repo_path)
    }

    pub fn list_remotes(&self, repo_path: &Path) -> Result<Vec<GitRemote>, GitServiceError> {
        let cli = GitCli::new();
        let remotes = cli.list_remotes(repo_path)?;

        Ok(remotes
            .into_iter()
            .map(|(name, url)| GitRemote { name, url })
            .collect())
    }

    pub fn check_remote_branch_exists(
        &self,
        repo_path: &Path,
        remote_url: &str,
        branch_name: &str,
    ) -> Result<bool, GitServiceError> {
        let git_cli = GitCli::new();
        git_cli
            .check_remote_branch_exists(repo_path, remote_url, branch_name)
            .map_err(GitServiceError::from)
    }

    pub fn fetch_branch(
        &self,
        repo_path: &Path,
        remote_url: &str,
        branch_name: &str,
    ) -> Result<(), GitServiceError> {
        let git_cli = GitCli::new();
        let refspec = format!("+refs/heads/{branch_name}:refs/heads/{branch_name}");
        git_cli
            .fetch_with_refspec(repo_path, remote_url, &refspec)
            .map_err(GitServiceError::from)
    }

    pub fn refresh_worktree_start_point(
        &self,
        repo_path: &Path,
        start_point: &str,
    ) -> Result<String, GitServiceError> {
        let repo = self.open_repo(repo_path)?;

        if repo.find_branch(start_point, BranchType::Local).is_ok() {
            return Ok(start_point.to_string());
        }

        if let Ok(remote_branch) = repo.find_branch(start_point, BranchType::Remote) {
            let remote_ref = remote_branch.into_reference();
            self.fetch_branch_from_remote(&repo, &remote_ref)?;
        }

        Ok(start_point.to_string())
    }

    pub fn resolve_remote_for_branch(
        &self,
        repo_path: &Path,
        branch_name: &str,
    ) -> Result<GitRemote, GitServiceError> {
        self.get_remote_from_branch_name(repo_path, branch_name)
            .or_else(|_| self.get_default_remote(repo_path))
    }

    fn get_remote_from_branch_ref<'a>(
        &self,
        repo: &'a Repository,
        branch_ref: &Reference,
    ) -> Result<Remote<'a>, GitServiceError> {
        let branch_name = branch_ref
            .name()
            .map(|name| name.to_string())
            .ok_or_else(|| GitServiceError::InvalidRepository("Invalid branch ref".into()))?;
        let remote_name_buf = repo.branch_remote_name(&branch_name)?;

        let remote_name = str::from_utf8(&remote_name_buf)
            .map_err(|e| {
                GitServiceError::InvalidRepository(format!(
                    "Invalid remote name for branch {branch_name}: {e}"
                ))
            })?
            .to_string();
        repo.find_remote(&remote_name).map_err(|_| {
            GitServiceError::InvalidRepository(format!(
                "Remote '{remote_name}' for branch '{branch_name}' not found"
            ))
        })
    }

    pub fn push_to_remote(
        &self,
        worktree_path: &Path,
        branch_name: &str,
        force: bool,
    ) -> Result<(), GitServiceError> {
        let repo = Repository::open(worktree_path)?;
        self.check_worktree_clean(&repo)?;

        // Get the remote
        let remote = self.default_remote(&repo, worktree_path)?;

        let git_cli = GitCli::new();
        if let Err(e) = git_cli.push(worktree_path, &remote.url, branch_name, force) {
            tracing::error!("Push to remote failed: {}", e);
            return Err(e.into());
        }

        let mut branch = Self::find_branch(&repo, branch_name)?;
        if !branch.get().is_remote() {
            if let Some(branch_target) = branch.get().target() {
                let remote_ref = format!("refs/remotes/{}/{branch_name}", remote.name);
                repo.reference(
                    &remote_ref,
                    branch_target,
                    true,
                    "update remote tracking branch",
                )?;
            }
            branch.set_upstream(Some(&format!("{}/{branch_name}", remote.name)))?;
        }

        Ok(())
    }

    /// Fetch from remote repository using native git authentication
    fn fetch_from_remote(
        &self,
        repo: &Repository,
        remote: &Remote,
        refspec: &str,
    ) -> Result<(), GitServiceError> {
        // Get the remote
        let remote_url = remote
            .url()
            .ok_or_else(|| GitServiceError::InvalidRepository("Remote has no URL".to_string()))?;

        let git_cli = GitCli::new();
        if let Err(e) = git_cli.fetch_with_refspec(repo.path(), remote_url, refspec) {
            tracing::error!("Fetch from GitHub failed: {}", e);
            return Err(e.into());
        }
        Ok(())
    }

    /// Fetch from remote repository using native git authentication
    fn fetch_branch_from_remote(
        &self,
        repo: &Repository,
        branch: &Reference,
    ) -> Result<(), GitServiceError> {
        let remote = self.get_remote_from_branch_ref(repo, branch)?;
        let default_remote = self.default_remote(repo, repo.path())?;
        let remote_name = remote.name().unwrap_or(&default_remote.name);
        let dest_ref = branch
            .name()
            .ok_or_else(|| GitServiceError::InvalidRepository("Invalid branch ref".into()))?;
        let remote_prefix = format!("refs/remotes/{remote_name}/");
        let src_ref = dest_ref.replacen(&remote_prefix, "refs/heads/", 1);
        let refspec = format!("+{src_ref}:{dest_ref}");
        self.fetch_from_remote(repo, &remote, &refspec)
    }

    /// Fetch from remote repository using native git authentication
    fn fetch_all_from_remote(
        &self,
        repo: &Repository,
        remote: &Remote,
    ) -> Result<(), GitServiceError> {
        let default_remote = self.default_remote(repo, repo.path())?;
        let remote_name = remote.name().unwrap_or(&default_remote.name);
        let refspec = format!("+refs/heads/*:refs/remotes/{remote_name}/*");
        self.fetch_from_remote(repo, remote, &refspec)
    }

    /// Clone a repository to the specified directory
    #[cfg(feature = "cloud")]
    pub fn clone_repository(
        clone_url: &str,
        target_path: &Path,
        token: Option<&str>,
    ) -> Result<Repository, GitServiceError> {
        use git2::{Cred, FetchOptions, RemoteCallbacks};

        if let Some(parent) = target_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        // Set up callbacks for authentication if token is provided
        let mut callbacks = RemoteCallbacks::new();
        if let Some(token) = token {
            callbacks.credentials(|_url, username_from_url, _allowed_types| {
                Cred::userpass_plaintext(username_from_url.unwrap_or("git"), token)
            });
        } else {
            // Fallback to SSH agent and key file authentication
            callbacks.credentials(|_url, username_from_url, _| {
                // Try SSH agent first
                if let Some(username) = username_from_url
                    && let Ok(cred) = Cred::ssh_key_from_agent(username)
                {
                    return Ok(cred);
                }

                // Fallback to key file (~/.ssh/id_rsa)
                let home = dirs::home_dir()
                    .ok_or_else(|| git2::Error::from_str("Could not find home directory"))?;
                let key_path = home.join(".ssh").join("id_rsa");
                Cred::ssh_key(username_from_url.unwrap_or("git"), None, &key_path, None)
            });
        }

        // Set up fetch options with our callbacks
        let mut fetch_opts = FetchOptions::new();
        fetch_opts.remote_callbacks(callbacks);

        // Create a repository builder with fetch options
        let mut builder = git2::build::RepoBuilder::new();
        builder.fetch_options(fetch_opts);

        let repo = builder.clone(clone_url, target_path)?;

        tracing::info!(
            "Successfully cloned repository from {} to {}",
            clone_url,
            target_path.display()
        );

        Ok(repo)
    }

    /// Collect file statistics from recent commits for ranking purposes
    pub fn collect_recent_file_stats(
        &self,
        repo_path: &Path,
        commit_limit: usize,
    ) -> Result<HashMap<String, FileStat>, GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        let mut stats: HashMap<String, FileStat> = HashMap::new();

        // Set up revision walk from HEAD
        let mut revwalk = repo.revwalk()?;
        revwalk.push_head()?;
        revwalk.set_sorting(Sort::TIME)?;

        // Iterate through recent commits
        for (commit_index, oid_result) in revwalk.take(commit_limit).enumerate() {
            let oid = oid_result?;
            let commit = repo.find_commit(oid)?;

            // Get commit timestamp
            let commit_time = {
                let time = commit.time();
                DateTime::from_timestamp(time.seconds(), 0).unwrap_or_else(Utc::now)
            };

            // Get the commit tree
            let commit_tree = commit.tree()?;

            // For the first commit (no parent), diff against empty tree
            let parent_tree = if commit.parent_count() == 0 {
                None
            } else {
                Some(commit.parent(0)?.tree()?)
            };

            // Create diff between parent and current commit
            let diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&commit_tree), None)?;

            // Process each changed file in this commit
            diff.foreach(
                &mut |delta, _progress| {
                    // Get the file path - prefer new file path, fall back to old
                    if let Some(path) = delta.new_file().path().or_else(|| delta.old_file().path())
                    {
                        let path_str = path.to_string_lossy().to_string();

                        // Update or insert file stats
                        let stat = stats.entry(path_str).or_insert(FileStat {
                            last_index: commit_index,
                            commit_count: 0,
                            last_time: commit_time,
                        });

                        // Increment commit count
                        stat.commit_count += 1;

                        // Keep the most recent change (smallest index)
                        if commit_index < stat.last_index {
                            stat.last_index = commit_index;
                            stat.last_time = commit_time;
                        }
                    }

                    true // Continue iteration
                },
                None, // No binary callback
                None, // No hunk callback
                None, // No line callback
            )?;
        }

        Ok(stats)
    }

}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;

    #[test]
    fn detailed_status_expands_untracked_directories_with_line_stats() {
        let td = TempDir::new().unwrap();
        let repo_path = td.path().join("repo");
        let service = GitService::new();
        service
            .initialize_repo_with_main_branch(&repo_path)
            .unwrap();

        std::fs::create_dir_all(repo_path.join("backend").join("routes")).unwrap();
        std::fs::create_dir_all(repo_path.join("frontend-react").join("src")).unwrap();
        std::fs::write(
            repo_path
                .join("backend")
                .join("routes")
                .join("contracts.js"),
            "one\ntwo\n",
        )
        .unwrap();
        std::fs::write(
            repo_path.join("frontend-react").join("src").join("App.jsx"),
            "three\n",
        )
        .unwrap();

        let status = service.get_detailed_status(&repo_path).unwrap();
        let paths = status
            .unstaged_files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>();

        assert_eq!(status.unstaged_files.len(), 2);
        assert!(paths.contains(&"backend/routes/contracts.js"));
        assert!(paths.contains(&"frontend-react/src/App.jsx"));
        assert_eq!(status.total_additions, 3);
        assert_eq!(status.total_deletions, 0);
        assert!(status.unstaged_files.iter().all(|file| file.status == "?"));
    }
}
