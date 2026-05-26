use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

use git2::{BranchType, Reference, Repository, Sort};

use crate::{Commit, CommitGraph, CommitGraphNode, GitCli, GitService, GitServiceError, HeadInfo};

impl GitService {
    pub(crate) fn get_branch_status_inner(
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
        revwalk.set_sorting(Sort::TIME | Sort::REVERSE)?;

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
        let merge_base = repo.merge_base(branch_oid, base_oid).ok();

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

        let branch_only: HashSet<git2::Oid> = {
            let mut rw = repo.revwalk()?;
            rw.push(branch_oid)?;
            rw.hide(base_oid)?;
            rw.filter_map(|r| r.ok()).collect()
        };

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
        let oid = repo
            .merge_base(
                branch.get().peel_to_commit()?.id(),
                base_branch.get().peel_to_commit()?.id(),
            )
            .map_err(GitServiceError::from)?;
        Ok(Commit::new(oid))
    }

    /// Get current HEAD information including branch name and commit OID.
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
            return Err(GitServiceError::InvalidRepository(
                "Repository HEAD has no target commit".to_string(),
            ));
        };

        Ok(HeadInfo { branch, oid })
    }

    pub fn get_current_branch(&self, repo_path: &Path) -> Result<String, git2::Error> {
        match self.get_head_info(repo_path) {
            Ok(head_info) => Ok(head_info.branch),
            Err(GitServiceError::Git(git_err)) => Err(git_err),
            Err(_) => Err(git2::Error::from_str("Failed to get head info")),
        }
    }

    /// Get the commit OID for a given branch without modifying HEAD.
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

    /// Get the subject/summary line for a given commit OID.
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

    /// Compare two OIDs and return (ahead, behind) counts.
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

    pub fn find_branch<'a>(
        repo: &'a Repository,
        branch_name: &str,
    ) -> Result<git2::Branch<'a>, GitServiceError> {
        match repo.find_branch(branch_name, BranchType::Local) {
            Ok(branch) => Ok(branch),
            Err(_) => match repo.find_branch(branch_name, BranchType::Remote) {
                Ok(branch) => Ok(branch),
                Err(_) => Err(GitServiceError::BranchNotFound(branch_name.to_string())),
            },
        }
    }
}
