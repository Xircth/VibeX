use std::path::Path;

use git2::Repository;

use crate::{GitCli, GitService, GitServiceError};

const BOOTSTRAP_COMMIT_NAME: &str = "VibeX";
const BOOTSTRAP_COMMIT_EMAIL: &str = "noreply@vibex.com";

impl GitService {
    /// Open the repository.
    pub fn open_repo(&self, repo_path: &Path) -> Result<Repository, GitServiceError> {
        Repository::open(repo_path).map_err(GitServiceError::from)
    }

    /// Validate the user's native Git identity without mutating repository config.
    pub(crate) fn validate_commit_identity(&self, repo_path: &Path) -> Result<(), GitServiceError> {
        let repo = self.open_repo(repo_path)?;
        self.configured_signature(&repo).map(|_| ())
    }

    /// Read the user's native Git identity. A missing identity is an actionable error.
    ///
    /// libgit2's config search can miss Git for Windows' global config in GUI
    /// processes (no `HOME`, different system gitconfig path). Fall back to the
    /// same `git config` the user already has working in Settings.
    pub(crate) fn configured_signature<'a>(
        &self,
        repo: &'a Repository,
    ) -> Result<git2::Signature<'a>, GitServiceError> {
        if let Ok(signature) = repo.signature() {
            return Ok(signature);
        }

        let identity_path = repo.workdir().unwrap_or_else(|| repo.path());
        if let Some((name, email)) = Self::cli_user_identity(identity_path) {
            return git2::Signature::now(&name, &email).map_err(GitServiceError::from);
        }

        Err(GitServiceError::CommitIdentityNotConfigured)
    }

    fn cli_user_identity(repo_path: &Path) -> Option<(String, String)> {
        let git = GitCli::new();
        let name = git.git(repo_path, ["config", "--get", "user.name"]).ok()?;
        let email = git.git(repo_path, ["config", "--get", "user.email"]).ok()?;
        let name = name.trim();
        let email = email.trim();
        if name.is_empty() || email.is_empty() {
            None
        } else {
            Some((name.to_string(), email.to_string()))
        }
    }

    /// Signature for commits VibeX authors itself rather than on the user's
    /// behalf: the empty bootstrap commit and the libgit2 squash merge. These
    /// must not hard-fail for a user who has never configured a Git identity,
    /// so they fall back to the VibeX identity. Does not write gitconfig.
    pub(crate) fn signature_with_bootstrap_fallback<'a>(
        &self,
        repo: &'a Repository,
    ) -> Result<git2::Signature<'a>, GitServiceError> {
        match self.configured_signature(repo) {
            Ok(signature) => Ok(signature),
            Err(GitServiceError::CommitIdentityNotConfigured) => {
                git2::Signature::now(BOOTSTRAP_COMMIT_NAME, BOOTSTRAP_COMMIT_EMAIL)
                    .map_err(GitServiceError::from)
            }
            Err(error) => Err(error),
        }
    }

    fn init_git_directory(repo_path: &Path) -> Result<Repository, GitServiceError> {
        let mut opts = git2::RepositoryInitOptions::new();
        opts.initial_head("main").mkdir(true);
        match Repository::init_opts(repo_path, &opts) {
            Ok(repo) => Ok(repo),
            Err(error) => {
                tracing::warn!(
                    error = %error,
                    path = %repo_path.display(),
                    "libgit2 init failed; falling back to git CLI"
                );
                let git = GitCli::new();
                if git.git(repo_path, ["init", "-b", "main"]).is_err() {
                    git.git(repo_path, ["init"])?;
                    git.git(repo_path, ["symbolic-ref", "HEAD", "refs/heads/main"])?;
                }
                Repository::open(repo_path).map_err(GitServiceError::from)
            }
        }
    }

    /// Initialize a new git repository with a main branch and initial commit.
    ///
    /// Safe to call again on a repo whose previous attempt created `.git` but
    /// never produced a commit (the Windows-visible "silent init" failure).
    pub fn initialize_repo_with_main_branch(
        &self,
        repo_path: &Path,
    ) -> Result<(), GitServiceError> {
        if !repo_path.exists() {
            std::fs::create_dir_all(repo_path)?;
        }

        if !repo_path.join(".git").exists() {
            Self::init_git_directory(repo_path)?;
        }

        self.ensure_main_branch_exists(repo_path)
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
        let signature = self.signature_with_bootstrap_fallback(repo)?;

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
        self.validate_commit_identity(path)?;
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
    fn init_identity_configured_signature_creates_main_branch_initial_commit() {
        let td = TempDir::new().unwrap();
        let repo_path = td.path().join("repo");
        let service = GitService::new();
        let repo = Repository::init(&repo_path).unwrap();
        {
            let mut config = repo.config().unwrap();
            config.set_str("user.name", "Configured User").unwrap();
            config
                .set_str("user.email", "configured@example.com")
                .unwrap();
        }
        service.create_initial_commit(&repo).unwrap();

        assert_eq!(repo.head().unwrap().name(), Some("refs/heads/main"));
        let head_commit = repo.head().unwrap().peel_to_commit().unwrap();
        assert_eq!(head_commit.message(), Some("Initial commit"));
        assert_eq!(head_commit.parent_count(), 0);
    }

    #[test]
    fn init_identity_ensure_main_branch_creates_empty_repo_commit_once() {
        let td = TempDir::new().unwrap();
        let repo_path = td.path().join("repo");
        let repo = Repository::init(&repo_path).unwrap();
        {
            let mut config = repo.config().unwrap();
            config.set_str("user.name", "Configured User").unwrap();
            config
                .set_str("user.email", "configured@example.com")
                .unwrap();
        }
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
    fn initialize_repo_completes_unborn_head_without_replacing_existing_commits() {
        let td = TempDir::new().unwrap();
        let unborn_path = td.path().join("unborn");
        Repository::init(&unborn_path).unwrap();
        let service = GitService::new();

        service
            .initialize_repo_with_main_branch(&unborn_path)
            .unwrap();

        let unborn = Repository::open(&unborn_path).unwrap();
        assert_eq!(unborn.head().unwrap().name(), Some("refs/heads/main"));
        let first_commit = unborn.head().unwrap().target().unwrap();

        service
            .initialize_repo_with_main_branch(&unborn_path)
            .unwrap();
        let second_commit = Repository::open(&unborn_path)
            .unwrap()
            .head()
            .unwrap()
            .target()
            .unwrap();
        assert_eq!(first_commit, second_commit);
    }

    #[test]
    fn initialize_repo_bootstrap_does_not_write_fallback_identity() {
        let td = TempDir::new().unwrap();
        let repo_path = td.path().join("repo");
        let service = GitService::new();
        service
            .initialize_repo_with_main_branch(&repo_path)
            .unwrap();

        let repo = Repository::open(&repo_path).unwrap();
        let local_cfg = repo.config().unwrap().open_level(ConfigLevel::Local);
        if let Ok(local_cfg) = local_cfg {
            let wrote_fallback = local_cfg.get_string("user.name").ok().as_deref()
                == Some(super::BOOTSTRAP_COMMIT_NAME)
                && local_cfg.get_string("user.email").ok().as_deref()
                    == Some(super::BOOTSTRAP_COMMIT_EMAIL);
            assert!(
                !wrote_fallback,
                "bootstrap commit must not write a fallback identity into repo gitconfig"
            );
        }
        assert_eq!(repo.head().unwrap().name(), Some("refs/heads/main"));
    }

    #[test]
    fn init_identity_validation_never_writes_a_fallback_identity() {
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

        let _ = service.validate_commit_identity(&repo_path);

        let repo = Repository::open(&repo_path).unwrap();
        let local_cfg = repo
            .config()
            .unwrap()
            .open_level(ConfigLevel::Local)
            .unwrap();
        assert_eq!(local_cfg.get_string("user.name").unwrap(), "Existing User");
        assert!(local_cfg.get_string("user.email").is_err());
    }
}
