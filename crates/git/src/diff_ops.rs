use std::path::Path;

use git2::{Delta, DiffFindOptions, DiffOptions, Repository};
use utils::diff::{Diff, DiffChangeKind, FileDiffDetails, compute_line_change_counts};

use crate::{
    DiffTarget, GitCli, GitService, GitServiceError,
    cli::{ChangeType, StatusDiffEntry, StatusDiffOptions},
};

// Max inline diff size for UI (in bytes). Files larger than this have their
// contents omitted from the diff stream to avoid UI crashes.
const MAX_INLINE_DIFF_BYTES: usize = 2 * 1024 * 1024;

impl GitService {
    /// Get diffs between branches or worktree changes.
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

                let mut find_opts = DiffFindOptions::new();
                diff.find_similar(Some(&mut find_opts))?;

                self.convert_diff_to_file_diffs(diff, &repo)
            }
            DiffTarget::Commit {
                repo_path,
                commit_sha,
            } => {
                let repo = self.open_repo(repo_path)?;
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

                let mut diff_opts = DiffOptions::new();
                diff_opts.include_typechange(true);

                if let Some(paths) = path_filter {
                    for path in paths {
                        diff_opts.pathspec(*path);
                    }
                }

                let mut diff = repo.diff_tree_to_tree(
                    Some(&parent_tree),
                    Some(&commit_tree),
                    Some(&mut diff_opts),
                )?;

                let mut find_opts = DiffFindOptions::new();
                diff.find_similar(Some(&mut find_opts))?;

                self.convert_diff_to_file_diffs(diff, &repo)
            }
        }
    }

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
                let mut content_omitted = false;
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

                if matches!(status, Delta::Modified)
                    && delta.old_file().mode() != delta.new_file().mode()
                    && old_content.is_some()
                    && new_content.is_some()
                    && old_content == new_content
                {
                    change = DiffChangeKind::PermissionChange;
                }

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

    /// Extract file path from a Diff for indexing and ConversationPatch.
    pub fn diff_path(diff: &Diff) -> String {
        diff.new_path
            .clone()
            .or_else(|| diff.old_path.clone())
            .unwrap_or_default()
    }

    fn blob_to_string(blob: &git2::Blob) -> Option<String> {
        if blob.is_binary() {
            None
        } else {
            std::str::from_utf8(blob.content())
                .ok()
                .map(|s| s.to_string())
        }
    }

    /// Read file content from filesystem with safety guards.
    pub(crate) fn read_file_to_string(repo: &Repository, rel_path: &Path) -> Option<String> {
        let workdir = repo.workdir()?;
        let abs_path = workdir.join(rel_path);

        let bytes = match std::fs::read(&abs_path) {
            Ok(bytes) => bytes,
            Err(e) => {
                tracing::debug!("Failed to read file from filesystem: {:?}: {}", abs_path, e);
                return None;
            }
        };

        if bytes.len() > MAX_INLINE_DIFF_BYTES {
            tracing::debug!(
                "Skipping large file ({}KB): {:?}",
                bytes.len() / 1024,
                abs_path
            );
            return None;
        }

        if bytes.contains(&0) {
            tracing::debug!("Skipping binary file: {:?}", abs_path);
            return None;
        }

        match String::from_utf8(bytes) {
            Ok(content) => Some(content),
            Err(e) => {
                tracing::debug!("File is not valid UTF-8: {:?}: {}", abs_path, e);
                None
            }
        }
    }

    fn create_file_details(
        &self,
        path: &Path,
        blob_id: &git2::Oid,
        repo: &Repository,
    ) -> FileDiffDetails {
        let file_name = path.to_string_lossy().to_string();

        let content = if !blob_id.is_zero() {
            repo.find_blob(*blob_id)
                .ok()
                .and_then(|blob| Self::blob_to_string(&blob))
                .or_else(|| {
                    tracing::debug!(
                        "Blob not found for non-zero OID, reading from filesystem: {}",
                        file_name
                    );
                    Self::read_file_to_string(repo, path)
                })
        } else {
            Self::read_file_to_string(repo, path)
        };

        FileDiffDetails {
            file_name: Some(file_name),
            content,
        }
    }

    fn status_entry_to_diff(repo: &Repository, base_tree: &git2::Tree, e: StatusDiffEntry) -> Diff {
        let mut change = match e.change {
            ChangeType::Added => DiffChangeKind::Added,
            ChangeType::Deleted => DiffChangeKind::Deleted,
            ChangeType::Modified => DiffChangeKind::Modified,
            ChangeType::Renamed => DiffChangeKind::Renamed,
            ChangeType::Copied => DiffChangeKind::Copied,
            ChangeType::TypeChanged | ChangeType::Unmerged => DiffChangeKind::Modified,
            ChangeType::Unknown(_) => DiffChangeKind::Modified,
        };

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

        let mut content_omitted = false;
        if let Some(ref oldp) = old_path_opt {
            let rel = Path::new(oldp);
            if let Ok(entry) = base_tree.get_path(rel)
                && entry.kind() == Some(git2::ObjectType::Blob)
                && let Ok(blob) = repo.find_blob(entry.id())
                && !blob.is_binary()
                && blob.size() > MAX_INLINE_DIFF_BYTES
            {
                content_omitted = true;
            }
        }
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

        let (old_content, new_content) = if content_omitted {
            (None, None)
        } else {
            let old_content = if let Some(ref oldp) = old_path_opt {
                let rel = Path::new(oldp);
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

            let new_content = if let Some(ref newp) = new_path_opt {
                let rel = Path::new(newp);
                Self::read_file_to_string(repo, rel)
            } else {
                None
            };
            (old_content, new_content)
        };

        if matches!(change, DiffChangeKind::Modified)
            && old_content.is_some()
            && new_content.is_some()
            && old_content == new_content
        {
            change = DiffChangeKind::PermissionChange;
        }

        let (additions, deletions) = match (&old_content, &new_content) {
            (Some(old), Some(new)) => {
                let (adds, dels) = compute_line_change_counts(old, new);
                (Some(adds), Some(dels))
            }
            (Some(old), None) => (Some(0), Some(old.lines().count())),
            (None, Some(new)) => (Some(new.lines().count()), Some(0)),
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
}
