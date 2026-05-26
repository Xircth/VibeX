use std::path::Path;

use git2::BranchType;

use crate::{GitCli, GitService, GitServiceError};

impl GitService {
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

    pub fn find_branch_type(
        &self,
        repo_path: &Path,
        branch_name: &str,
    ) -> Result<BranchType, GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        match repo.find_branch(branch_name, BranchType::Local) {
            Ok(_) => Ok(BranchType::Local),
            Err(_) => match repo.find_branch(branch_name, BranchType::Remote) {
                Ok(_) => Ok(BranchType::Remote),
                Err(_) => Err(GitServiceError::BranchNotFound(branch_name.to_string())),
            },
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
}
