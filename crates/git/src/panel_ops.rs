use std::{collections::HashMap, path::Path};

use git2::Repository;

use crate::{
    CommitDetail, CommitFileEntry, DetailedGitStatus, GitCli, GitFileDiffEntry, GitFileStatusEntry,
    GitLogEntry, GitLogStatus, GitService, GitServiceError, PullResult, ResetMode,
};

impl GitService {
    /// Get detailed file status grouped into staged and unstaged files.
    /// Returns structured data suitable for a Git staging UI.
    pub fn get_detailed_status(
        &self,
        worktree_path: &Path,
    ) -> Result<DetailedGitStatus, GitServiceError> {
        let git = GitCli::new();
        let status = git
            .get_worktree_status(worktree_path)
            .map_err(|e| GitServiceError::InvalidRepository(format!("git status failed: {e}")))?;
        let branch_name = git.get_current_branch(worktree_path).unwrap_or_default();
        let repo = self.open_repo(worktree_path)?;

        let staged_numstat = git.get_numstat_staged(worktree_path).unwrap_or_else(|e| {
            tracing::warn!(error = %e, "git numstat (staged) failed; reporting zero line counts");
            String::new()
        });
        let staged_stats = parse_numstat(&staged_numstat);

        let all_numstat = git.get_numstat(worktree_path).unwrap_or_else(|e| {
            tracing::warn!(error = %e, "git numstat failed; reporting zero line counts");
            String::new()
        });
        let all_stats = parse_numstat(&all_numstat);

        let mut staged_files = Vec::new();
        let mut unstaged_files = Vec::new();
        let mut total_additions: i32 = 0;
        let mut total_deletions: i32 = 0;

        for entry in &status.entries {
            let path_str = String::from_utf8_lossy(&entry.path).to_string();

            if entry.staged != ' ' && entry.staged != '?' {
                let (adds, dels) = staged_stats.get(&path_str).copied().unwrap_or((0, 0));
                staged_files.push(GitFileStatusEntry {
                    path: path_str.clone(),
                    status: char_to_status_string(entry.staged),
                    additions: adds,
                    deletions: dels,
                });
                total_additions += adds;
                total_deletions += dels;
            }

            if entry.is_untracked {
                let (adds, dels) = all_stats
                    .get(&path_str)
                    .copied()
                    .unwrap_or_else(|| untracked_file_stats(&repo, &path_str));
                unstaged_files.push(GitFileStatusEntry {
                    path: path_str,
                    status: "?".to_string(),
                    additions: adds,
                    deletions: dels,
                });
                total_additions += adds;
                total_deletions += dels;
            } else if entry.unstaged != ' ' {
                let (all_adds, all_dels) = all_stats.get(&path_str).copied().unwrap_or((0, 0));
                let (stg_adds, stg_dels) = staged_stats.get(&path_str).copied().unwrap_or((0, 0));
                let adds = (all_adds - stg_adds).max(0);
                let dels = (all_dels - stg_dels).max(0);
                unstaged_files.push(GitFileStatusEntry {
                    path: path_str,
                    status: char_to_status_string(entry.unstaged),
                    additions: adds,
                    deletions: dels,
                });
                total_additions += adds;
                total_deletions += dels;
            }
        }

        Ok(DetailedGitStatus {
            branch_name,
            staged_files,
            unstaged_files,
            total_additions,
            total_deletions,
        })
    }

    /// Stage a single file.
    pub fn stage_file(&self, worktree_path: &Path, file_path: &str) -> Result<(), GitServiceError> {
        let git = GitCli::new();
        git.stage_file(worktree_path, file_path)
            .map_err(|e| GitServiceError::InvalidRepository(format!("git add failed: {e}")))
    }

    /// Stage all files.
    pub fn stage_all(&self, worktree_path: &Path) -> Result<(), GitServiceError> {
        let git = GitCli::new();
        git.add_all(worktree_path)
            .map_err(|e| GitServiceError::InvalidRepository(format!("git add -A failed: {e}")))
    }

    /// Unstage a single file.
    pub fn unstage_file(
        &self,
        worktree_path: &Path,
        file_path: &str,
    ) -> Result<(), GitServiceError> {
        let git = GitCli::new();
        git.unstage_file(worktree_path, file_path)
            .map_err(|e| GitServiceError::InvalidRepository(format!("git unstage failed: {e}")))
    }

    /// Revert a single file to HEAD state.
    pub fn revert_file(
        &self,
        worktree_path: &Path,
        file_path: &str,
    ) -> Result<(), GitServiceError> {
        let git = GitCli::new();
        git.restore_file(worktree_path, file_path)
            .map_err(|e| GitServiceError::InvalidRepository(format!("git restore failed: {e}")))
    }

    /// Revert all files to HEAD state and remove untracked files.
    pub fn revert_all(&self, worktree_path: &Path) -> Result<(), GitServiceError> {
        let git = GitCli::new();
        git.restore_all(worktree_path)
            .map_err(|e| GitServiceError::InvalidRepository(format!("git restore all failed: {e}")))
    }

    /// Get unified diff content for all changed files vs HEAD.
    /// Each entry includes the file path, status, and diff content.
    pub fn get_file_diffs(
        &self,
        worktree_path: &Path,
    ) -> Result<Vec<GitFileDiffEntry>, GitServiceError> {
        let git = GitCli::new();
        let status = git
            .get_worktree_status(worktree_path)
            .map_err(|e| GitServiceError::InvalidRepository(format!("git status failed: {e}")))?;

        let mut diffs = Vec::new();
        for entry in &status.entries {
            let path_str = String::from_utf8_lossy(&entry.path).to_string();
            let status_char = if entry.is_untracked {
                '?'
            } else if entry.staged != ' ' {
                entry.staged
            } else {
                entry.unstaged
            };

            let is_binary = is_likely_binary(&path_str);
            let is_image = is_image_file(&path_str);

            let diff_content = if is_binary {
                String::new()
            } else {
                git.get_diff_file(worktree_path, &path_str)
                    .unwrap_or_default()
            };

            diffs.push(GitFileDiffEntry {
                path: path_str,
                status: char_to_status_string(status_char),
                diff: diff_content,
                is_binary,
                is_image,
            });
        }

        Ok(diffs)
    }

    /// Commit staged changes with the given message.
    pub fn commit_changes(
        &self,
        worktree_path: &Path,
        message: &str,
    ) -> Result<(), GitServiceError> {
        let git = GitCli::new();
        git.commit(worktree_path, message)
            .map_err(|e| GitServiceError::InvalidRepository(format!("git commit failed: {e}")))
    }

    /// Get git log entries for the current branch.
    pub fn get_log(
        &self,
        worktree_path: &Path,
        max_count: usize,
    ) -> Result<Vec<GitLogEntry>, GitServiceError> {
        let git = GitCli::new();
        let raw = git
            .get_log(worktree_path, max_count)
            .map_err(|e| GitServiceError::InvalidRepository(format!("git log failed: {e}")))?;

        let mut entries = Vec::new();
        for line in raw.lines() {
            let parts: Vec<&str> = line.splitn(5, '\0').collect();
            if parts.len() >= 4 {
                let refs = if parts.len() >= 5 && !parts[4].is_empty() {
                    parts[4]
                        .split(", ")
                        .map(|r| r.strip_prefix("HEAD -> ").unwrap_or(r).to_string())
                        .filter(|r| r != "HEAD")
                        .collect()
                } else {
                    Vec::new()
                };
                entries.push(GitLogEntry {
                    sha: parts[0].to_string(),
                    summary: parts[1].to_string(),
                    author: parts[2].to_string(),
                    timestamp: parts[3].parse::<i64>().unwrap_or(0),
                    refs,
                });
            }
        }
        Ok(entries)
    }

    /// Pull from remote (fetch + fast-forward merge) for the current branch.
    pub fn pull(&self, worktree_path: &Path) -> Result<PullResult, GitServiceError> {
        let git = GitCli::new();

        let upstream_before = git.get_upstream_branch(worktree_path).unwrap_or(None);
        let behind_before = if let Some(ref up) = upstream_before {
            git.get_rev_list_count(worktree_path, up, "HEAD")
                .map(|(_, behind)| behind)
                .unwrap_or(0)
        } else {
            0
        };

        match git.pull(worktree_path) {
            Ok(_) => Ok(PullResult {
                success: true,
                new_commits: behind_before as u32,
                error: None,
            }),
            Err(e) => Ok(PullResult {
                success: false,
                new_commits: 0,
                error: Some(format!("{e}")),
            }),
        }
    }

    /// Fetch all remotes to update tracking branches.
    pub fn fetch_all(&self, worktree_path: &Path) -> Result<(), GitServiceError> {
        let git = GitCli::new();
        git.fetch_all(worktree_path).map_err(|e| {
            GitServiceError::InvalidRepository(format!("git fetch --all failed: {e}"))
        })?;
        Ok(())
    }

    /// Checkout an existing local branch.
    pub fn checkout_branch(
        &self,
        worktree_path: &Path,
        branch_name: &str,
    ) -> Result<(), GitServiceError> {
        let git = GitCli::new();
        git.checkout_branch(worktree_path, branch_name)
            .map_err(|e| GitServiceError::InvalidRepository(format!("git checkout failed: {e}")))
    }

    /// Create a new branch and switch to it.
    pub fn create_branch(
        &self,
        worktree_path: &Path,
        branch_name: &str,
        from_ref: Option<&str>,
    ) -> Result<(), GitServiceError> {
        let git = GitCli::new();
        git.create_and_checkout_branch(worktree_path, branch_name, from_ref)
            .map_err(|e| {
                GitServiceError::InvalidRepository(format!("git create branch failed: {e}"))
            })
    }

    /// Get ahead/behind counts for the current branch vs its upstream.
    pub fn get_log_status(&self, worktree_path: &Path) -> Result<GitLogStatus, GitServiceError> {
        let git = GitCli::new();
        let branch = git.get_current_branch(worktree_path).unwrap_or_default();
        let upstream = git.get_upstream_branch(worktree_path).unwrap_or(None);

        let (ahead, behind) = if let Some(ref up) = upstream {
            git.get_rev_list_count(worktree_path, up, "HEAD")
                .unwrap_or((0, 0))
        } else {
            (0, 0)
        };

        let entries = self.get_log(worktree_path, 100)?;
        let total = entries.len() as i32;

        Ok(GitLogStatus {
            entries,
            total,
            ahead: ahead as i32,
            behind: behind as i32,
            upstream,
            branch_name: branch,
        })
    }

    /// Get detailed information about a single commit.
    pub fn get_commit_detail(
        &self,
        worktree_path: &Path,
        sha: &str,
    ) -> Result<CommitDetail, GitServiceError> {
        let git = GitCli::new();
        let (summary, body, author, author_email, timestamp) = git
            .show_commit(worktree_path, sha)
            .map_err(GitServiceError::from)?;

        let raw_files = git
            .show_commit_files(worktree_path, sha)
            .map_err(GitServiceError::from)?;

        let files = raw_files
            .into_iter()
            .map(|(path, status, additions, deletions)| CommitFileEntry {
                path,
                status,
                additions,
                deletions,
            })
            .collect();

        Ok(CommitDetail {
            sha: sha.to_string(),
            summary,
            body,
            author,
            author_email,
            timestamp,
            files,
        })
    }

    /// Cherry-pick a commit onto the current branch.
    pub fn cherry_pick_commit(
        &self,
        worktree_path: &Path,
        sha: &str,
    ) -> Result<(), GitServiceError> {
        let git = GitCli::new();
        git.cherry_pick(worktree_path, sha)
            .map_err(GitServiceError::from)
    }

    /// Revert a commit (creates a new undo commit).
    pub fn revert_commit(&self, worktree_path: &Path, sha: &str) -> Result<(), GitServiceError> {
        let git = GitCli::new();
        git.revert_commit(worktree_path, sha)
            .map_err(GitServiceError::from)
    }

    /// Reset current branch to a specific commit.
    pub fn reset_to_commit(
        &self,
        worktree_path: &Path,
        sha: &str,
        mode: &ResetMode,
    ) -> Result<(), GitServiceError> {
        let mode_str = match mode {
            ResetMode::Soft => "soft",
            ResetMode::Mixed => "mixed",
            ResetMode::Hard => "hard",
        };
        let git = GitCli::new();
        git.reset_to(worktree_path, sha, mode_str)
            .map_err(GitServiceError::from)
    }

    /// Create a new branch at a specific commit.
    pub fn create_branch_at_commit(
        &self,
        worktree_path: &Path,
        branch_name: &str,
        sha: &str,
    ) -> Result<(), GitServiceError> {
        let git = GitCli::new();
        git.create_branch_at(worktree_path, branch_name, sha)
            .map_err(GitServiceError::from)
    }
}

fn untracked_file_stats(repo: &Repository, path: &str) -> (i32, i32) {
    let additions = GitService::read_file_to_string(repo, Path::new(path))
        .map(|content| content.lines().count() as i32)
        .unwrap_or(0);
    (additions, 0)
}

fn parse_numstat(raw: &str) -> HashMap<String, (i32, i32)> {
    let mut map = HashMap::new();
    for line in raw.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() >= 3 {
            let adds = parts[0].parse::<i32>().unwrap_or(0);
            let dels = parts[1].parse::<i32>().unwrap_or(0);
            map.insert(parts[2].to_string(), (adds, dels));
        }
    }
    map
}

fn char_to_status_string(c: char) -> String {
    match c {
        'M' => "M".to_string(),
        'A' => "A".to_string(),
        'D' => "D".to_string(),
        'R' => "R".to_string(),
        'C' => "C".to_string(),
        'T' => "T".to_string(),
        'U' => "U".to_string(),
        '?' => "?".to_string(),
        _ => "M".to_string(),
    }
}

fn is_likely_binary(path: &str) -> bool {
    let binary_exts = [
        ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg", ".mp3", ".mp4", ".wav",
        ".avi", ".mov", ".zip", ".tar", ".gz", ".rar", ".7z", ".exe", ".dll", ".so", ".dylib",
        ".woff", ".woff2", ".ttf", ".otf", ".eot", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".db",
        ".sqlite", ".sqlite3",
    ];
    let lower = path.to_lowercase();
    binary_exts.iter().any(|ext| lower.ends_with(ext))
}

fn is_image_file(path: &str) -> bool {
    let image_exts = [
        ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg",
    ];
    let lower = path.to_lowercase();
    image_exts.iter().any(|ext| lower.ends_with(ext))
}
