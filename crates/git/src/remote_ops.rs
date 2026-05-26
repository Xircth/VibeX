use std::{path::Path, str};

use git2::{BranchType, Reference, Remote, Repository};

use crate::{GitCli, GitRemote, GitService, GitServiceError};

impl GitService {
    fn default_remote(
        &self,
        repo: &Repository,
        repo_path: &Path,
    ) -> Result<GitRemote, GitServiceError> {
        let mut remotes = GitCli::new().list_remotes(repo_path)?;

        if let Ok(config) = repo.config()
            && let Ok(default_name) = config.get_string("remote.pushDefault")
            && let Some(idx) = remotes.iter().position(|(name, _)| name == &default_name)
        {
            let (name, url) = remotes.swap_remove(idx);
            return Ok(GitRemote { name, url });
        }

        remotes
            .into_iter()
            .next()
            .map(|(name, url)| GitRemote { name, url })
            .ok_or_else(|| GitServiceError::InvalidRepository("No remotes configured".to_string()))
    }

    pub fn get_remote_branch_status(
        &self,
        repo_path: &Path,
        branch_name: &str,
        base_branch_name: Option<&str>,
    ) -> Result<(usize, usize), GitServiceError> {
        let repo = Repository::open(repo_path)?;
        let branch_ref = Self::find_branch(&repo, branch_name)?.into_reference();
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

    fn fetch_from_remote(
        &self,
        repo: &Repository,
        remote: &Remote,
        refspec: &str,
    ) -> Result<(), GitServiceError> {
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

    pub(crate) fn fetch_branch_from_remote(
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

    /// Clone a repository to the specified directory.
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

        let mut callbacks = RemoteCallbacks::new();
        if let Some(token) = token {
            callbacks.credentials(|_url, username_from_url, _allowed_types| {
                Cred::userpass_plaintext(username_from_url.unwrap_or("git"), token)
            });
        } else {
            callbacks.credentials(|_url, username_from_url, _| {
                if let Some(username) = username_from_url
                    && let Ok(cred) = Cred::ssh_key_from_agent(username)
                {
                    return Ok(cred);
                }

                let home = dirs::home_dir()
                    .ok_or_else(|| git2::Error::from_str("Could not find home directory"))?;
                let key_path = home.join(".ssh").join("id_rsa");
                Cred::ssh_key(username_from_url.unwrap_or("git"), None, &key_path, None)
            });
        }

        let mut fetch_opts = FetchOptions::new();
        fetch_opts.remote_callbacks(callbacks);

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
}
