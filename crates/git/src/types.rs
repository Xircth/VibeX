use std::path::Path;

use chrono::{DateTime, Utc};
use git2::Error as GitError;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use ts_rs::TS;

use super::GitCliError;

/// Statistics for a single file based on git history
#[derive(Clone, Debug)]
pub struct FileStat {
    /// Index in the commit history (0 = HEAD, 1 = parent of HEAD, ...)
    pub last_index: usize,
    /// Number of times this file was changed in recent commits
    pub commit_count: u32,
    /// Timestamp of the most recent change
    pub last_time: DateTime<Utc>,
}

#[derive(Debug, Error)]
pub enum GitServiceError {
    #[error(transparent)]
    Git(#[from] GitError),
    #[error(transparent)]
    GitCLI(#[from] GitCliError),
    #[error(transparent)]
    IoError(#[from] std::io::Error),
    #[error("Invalid repository: {0}")]
    InvalidRepository(String),
    #[error("Branch not found: {0}")]
    BranchNotFound(String),
    #[error("Merge conflicts: {message}")]
    MergeConflicts {
        message: String,
        conflicted_files: Vec<String>,
    },
    #[error("Branches diverged: {0}")]
    BranchesDiverged(String),
    #[error("{0} has uncommitted changes: {1}")]
    WorktreeDirty(String, String),
    #[error("Rebase in progress; resolve or abort it before retrying")]
    RebaseInProgress,
    #[error(
        "Git commit identity is not configured; set user.name and user.email before committing"
    )]
    CommitIdentityNotConfigured,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[ts(rename_all = "snake_case")]
pub enum ConflictOp {
    Rebase,
    Merge,
    CherryPick,
    Revert,
}

#[derive(Debug, Serialize, TS)]
pub struct GitBranch {
    pub name: String,
    pub is_current: bool,
    pub is_remote: bool,
    pub is_worktree: bool,
    pub worktree_path: Option<String>,
    #[ts(type = "Date")]
    pub last_commit_date: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, TS)]
pub struct GitRemote {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone)]
pub struct HeadInfo {
    pub branch: String,
    pub oid: String,
}

/// A single node in the commit graph.
#[derive(Debug, Clone, Serialize)]
pub struct CommitGraphNode {
    pub hash: String,
    pub full_hash: String,
    pub message: String,
    pub author: String,
    pub timestamp: i64,
    pub parents: Vec<String>,
    pub refs: Vec<String>,
    pub is_current_branch: bool,
}

/// Full commit graph result for two branches.
#[derive(Debug, Clone, Serialize)]
pub struct CommitGraph {
    pub nodes: Vec<CommitGraphNode>,
    pub merge_base: Option<String>,
    pub current_branch: String,
    pub target_branch: String,
}

/// A single file entry in git status (staged or unstaged).
#[derive(Debug, Clone, Serialize, TS)]
pub struct GitFileStatusEntry {
    pub path: String,
    /// Status code: "A" (added), "M" (modified), "D" (deleted), "R" (renamed), "?" (untracked)
    pub status: String,
    pub additions: i32,
    pub deletions: i32,
}

/// One entry in the stash stack. `index` is the 0-based position in
/// `git stash list` (i.e. `stash@{index}`); `message` is the stash subject.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
pub struct StashEntry {
    pub index: usize,
    pub message: String,
    /// The branch the stash was created on, parsed from the subject when present.
    #[ts(optional)]
    pub branch: Option<String>,
}

/// Parse `git stash list --format=%gd%x1f%gs` output. Each line is
/// `stash@{N}<0x1f>WIP on <branch>: <hash> <subject>`; the 0x1f unit separator
/// keeps subjects that contain spaces intact.
pub fn parse_stash_list(raw: &str) -> Vec<StashEntry> {
    raw.lines()
        .filter_map(|line| {
            let (selector, subject) = line.split_once('\u{1f}')?;
            let index = selector
                .trim()
                .strip_prefix("stash@{")?
                .strip_suffix('}')?
                .parse::<usize>()
                .ok()?;
            let message = subject.trim().to_string();
            // Subjects look like "WIP on main: 1a2b3c commit subject" or
            // "On main: custom message".
            let branch = message
                .strip_prefix("WIP on ")
                .or_else(|| message.strip_prefix("On "))
                .and_then(|rest| rest.split_once(':'))
                .map(|(branch, _)| branch.trim().to_string())
                .filter(|branch| !branch.is_empty());
            Some(StashEntry {
                index,
                message,
                branch,
            })
        })
        .collect()
}

/// Detailed git status response with staged/unstaged file grouping.
#[derive(Debug, Clone, Serialize, TS)]
pub struct DetailedGitStatus {
    pub branch_name: String,
    pub staged_files: Vec<GitFileStatusEntry>,
    pub unstaged_files: Vec<GitFileStatusEntry>,
    pub total_additions: i32,
    pub total_deletions: i32,
}

/// A single file diff entry with content.
#[derive(Debug, Clone, Serialize, TS)]
pub struct GitFileDiffEntry {
    pub path: String,
    pub status: String,
    pub diff: String,
    pub is_binary: bool,
    pub is_image: bool,
}

/// A single git log entry.
#[derive(Debug, Clone, Serialize, TS)]
pub struct GitLogEntry {
    pub sha: String,
    pub summary: String,
    pub author: String,
    pub timestamp: i64,
    /// Branch/tag refs pointing at this commit (e.g. "master", "origin/main", "v1.0").
    pub refs: Vec<String>,
}

/// A single file changed in a commit.
#[derive(Debug, Clone, Serialize, TS)]
pub struct CommitFileEntry {
    pub path: String,
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
}

/// Detailed information about a single commit.
#[derive(Debug, Clone, Serialize, TS)]
pub struct CommitDetail {
    pub sha: String,
    pub summary: String,
    pub body: String,
    pub author: String,
    pub author_email: String,
    pub timestamp: i64,
    pub files: Vec<CommitFileEntry>,
}

/// Mode for git reset.
#[derive(Debug, Clone, Deserialize, TS)]
pub enum ResetMode {
    #[serde(rename = "soft")]
    Soft,
    #[serde(rename = "mixed")]
    Mixed,
    #[serde(rename = "hard")]
    Hard,
}

/// Git log response with ahead/behind tracking.
#[derive(Debug, Clone, Serialize, TS)]
pub struct GitLogStatus {
    pub entries: Vec<GitLogEntry>,
    pub total: i32,
    pub ahead: i32,
    pub behind: i32,
    pub upstream: Option<String>,
    pub branch_name: String,
}

/// Result of a git pull operation.
#[derive(Debug, Clone, Serialize, TS)]
pub struct PullResult {
    pub success: bool,
    pub new_commits: u32,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Commit(git2::Oid);

impl Commit {
    pub fn new(id: git2::Oid) -> Self {
        Self(id)
    }

    pub fn as_oid(&self) -> git2::Oid {
        self.0
    }
}

impl std::fmt::Display for Commit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[derive(Debug, Clone, Copy)]
pub struct WorktreeResetOptions {
    pub perform_reset: bool,
    pub force_when_dirty: bool,
    pub is_dirty: bool,
    pub log_skip_when_dirty: bool,
}

impl WorktreeResetOptions {
    pub fn new(
        perform_reset: bool,
        force_when_dirty: bool,
        is_dirty: bool,
        log_skip_when_dirty: bool,
    ) -> Self {
        Self {
            perform_reset,
            force_when_dirty,
            is_dirty,
            log_skip_when_dirty,
        }
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct WorktreeResetOutcome {
    pub needed: bool,
    pub applied: bool,
}

/// Target for diff generation
pub enum DiffTarget<'p> {
    /// Work-in-progress branch checked out in this worktree
    Worktree {
        worktree_path: &'p Path,
        base_commit: &'p Commit,
    },
    /// Fully committed branch vs base branch
    Branch {
        repo_path: &'p Path,
        branch_name: &'p str,
        base_branch: &'p str,
    },
    /// Specific commit vs base branch
    Commit {
        repo_path: &'p Path,
        commit_sha: &'p str,
    },
}

#[cfg(test)]
mod stash_parse_tests {
    use super::*;

    #[test]
    fn parses_indices_and_messages() {
        let raw =
            "stash@{0}\u{1f}WIP on main: 1a2b3c fix bug\nstash@{1}\u{1f}On feature/x: my note";
        let entries = parse_stash_list(raw);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].index, 0);
        assert_eq!(entries[0].message, "WIP on main: 1a2b3c fix bug");
        assert_eq!(entries[0].branch.as_deref(), Some("main"));
        assert_eq!(entries[1].index, 1);
        assert_eq!(entries[1].branch.as_deref(), Some("feature/x"));
    }

    #[test]
    fn empty_output_is_empty_list() {
        assert!(parse_stash_list("").is_empty());
        assert!(parse_stash_list("\n\n").is_empty());
    }

    #[test]
    fn malformed_lines_are_skipped() {
        // No unit separator → skipped; valid line still parsed.
        let raw = "garbage line\nstash@{0}\u{1f}WIP on main: subj";
        let entries = parse_stash_list(raw);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].index, 0);
    }

    #[test]
    fn subject_without_branch_prefix_has_none() {
        let raw = "stash@{0}\u{1f}some freeform subject";
        let entries = parse_stash_list(raw);
        assert_eq!(entries[0].branch, None);
    }
}
