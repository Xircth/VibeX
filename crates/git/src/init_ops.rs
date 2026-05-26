use std::path::Path;

use git2::{ConfigLevel, Repository};

use crate::{GitCli, GitService, GitServiceError};

impl GitService {
    /// Open the repository.
    pub fn open_repo(&self, repo_path: &Path) -> Result<Repository, GitServiceError> {
        Repository::open(repo_path).map_err(GitServiceError::from)
    }

    /// Ensure local (repo-scoped) identity exists for CLI commits.
    /// Sets only missing local user.name/email values.
    pub(crate) fn ensure_cli_commit_identity(
        &self,
        repo_path: &Path,
    ) -> Result<(), GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        let mut local_cfg = repo.config()?.open_level(ConfigLevel::Local)?;

        if local_cfg.get_string("user.name").is_err() {
            local_cfg.set_str("user.name", "VibeX")?;
        }
        if local_cfg.get_string("user.email").is_err() {
            local_cfg.set_str("user.email", "noreply@vibex.com")?;
        }

        Ok(())
    }

    /// Get a signature for libgit2 commits with a safe fallback identity.
    pub(crate) fn signature_with_fallback<'a>(
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

    /// Initialize a new git repository with a main branch and initial commit.
    pub fn initialize_repo_with_main_branch(
        &self,
        repo_path: &Path,
    ) -> Result<(), GitServiceError> {
        if !repo_path.exists() {
            std::fs::create_dir_all(repo_path)?;
        }

        let repo = Repository::init_opts(
            repo_path,
            git2::RepositoryInitOptions::new()
                .initial_head("main")
                .mkdir(true),
        )?;

        self.create_initial_commit(&repo)?;

        Ok(())
    }

    /// Ensure an existing repository has a main branch for empty repositories.
    pub fn ensure_main_branch_exists(&self, repo_path: &Path) -> Result<(), GitServiceError> {
        let repo = self.open_repo(repo_path)?;

        match repo.branches(None) {
            Ok(branches) => {
                if branches.count() == 0 {
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

        let _commit_id = repo.commit(
            Some("refs/heads/main"),
            &signature,
            &signature,
            "Initial commit",
            &tree,
            &[],
        )?;

        repo.set_head("refs/heads/main")?;

        Ok(())
    }

    pub fn commit(&self, path: &Path, message: &str) -> Result<bool, GitServiceError> {
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
        self.ensure_cli_commit_identity(path)?;
        git.commit(path, message)
            .map_err(|e| GitServiceError::InvalidRepository(format!("git commit failed: {e}")))?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use git2::{ConfigLevel, Repository};
    use tempfile::TempDir;

    use crate::GitService;

    #[test]
    fn init_identity_initialize_repo_creates_main_branch_initial_commit() {
        let td = TempDir::new().unwrap();
        let repo_path = td.path().join("repo");
        let service = GitService::new();

        service
            .initialize_repo_with_main_branch(&repo_path)
            .unwrap();

        let repo = Repository::open(&repo_path).unwrap();
        assert_eq!(repo.head().unwrap().name(), Some("refs/heads/main"));
        let head_commit = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head_commit.message(), Some("Initial commit"));
        assert_eq!(head_commit.parent_count(), 0);
    }

    #[test]
    fn init_identity_ensure_main_branch_creates_empty_repo_commit_once() {
        let td = TempDir::new().unwrap();
        let repo_path = td.path().join("repo");
        Repository::init(&repo_path).unwrap();
        let service = GitService::new();

        service.ensure_main_branch_exists(&repo_path).unwrap();
        let repo = Repository::open(&repo_path).unwrap();
        let first_commit = repo.head().unwrap().target().unwrap();

        service.ensure_main_branch_exists(&repo_path).unwrap();
        let second_commit = repo.head().unwrap().target().unwrap();

        assert_eq!(repo.head().unwrap().name(), Some("refs/heads/main"));
        assert_eq!(first_commit, second_commit);
    }

    #[test]
    fn init_identity_cli_identity_fills_only_missing_local_values() {
        let td = TempDir::new().unwrap();
        let repo_path = td.path().join("repo");
        let repo = Repository::init(&repo_path).unwrap();
        {
            let mut local_cfg = repo
                .config()
                .unwrap()
                .open_level(ConfigLevel::Local)
                .unwrap();
            local_cfg.set_str("user.name", "Existing User").unwrap();
        }
        let service = GitService::new();

        service.ensure_cli_commit_identity(&repo_path).unwrap();

        let repo = Repository::open(&repo_path).unwrap();
        let local_cfg = repo
            .config()
            .unwrap()
            .open_level(ConfigLevel::Local)
            .unwrap();
        assert_eq!(local_cfg.get_string("user.name").unwrap(), "Existing User");
        assert_eq!(
            local_cfg.get_string("user.email").unwrap(),
            "noreply@vibex.com"
        );
    }
}
