use std::path::{Path, PathBuf};

use db::models::repo::Repo as RepoModel;
use git::{GitCli, GitService, GitServiceError};
use sqlx::SqlitePool;
use thiserror::Error;
use utils::path::{expand_tilde, normalize_windows_extended_path_prefix};
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum RepoError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("Path does not exist: {0}")]
    PathNotFound(PathBuf),
    #[error("Path is not a directory: {0}")]
    PathNotDirectory(PathBuf),
    #[error("Path is not a git repository: {0}")]
    NotGitRepository(PathBuf),
    #[error("Repository not found")]
    NotFound,
    #[error("Directory already exists: {0}")]
    DirectoryAlreadyExists(PathBuf),
    #[error("Git error: {0}")]
    Git(#[from] GitServiceError),
    #[error("Invalid folder name: {0}")]
    InvalidFolderName(String),
}

pub type Result<T> = std::result::Result<T, RepoError>;

#[derive(Clone, Default)]
pub struct RepoService;

impl RepoService {
    pub fn new() -> Self {
        Self
    }

    pub fn resolve_git_repo_path(&self, path: &Path) -> Result<PathBuf> {
        if !path.exists() {
            return Err(RepoError::PathNotFound(path.to_path_buf()));
        }

        if !path.is_dir() {
            return Err(RepoError::PathNotDirectory(path.to_path_buf()));
        }

        if !path.join(".git").exists() {
            return Err(RepoError::NotGitRepository(path.to_path_buf()));
        }

        if let Some(repo_path) = self.resolve_git_repo_path_with_libgit2(path)? {
            return Ok(repo_path);
        }

        if let Some(repo_path) = self.resolve_git_repo_path_with_cli(path)? {
            return Ok(repo_path);
        }

        Err(RepoError::NotGitRepository(path.to_path_buf()))
    }

    fn resolve_git_repo_path_with_libgit2(&self, path: &Path) -> Result<Option<PathBuf>> {
        let repository = match git2::Repository::open(path) {
            Ok(repository) => repository,
            Err(_) => return Ok(None),
        };
        let Some(workdir) = repository.workdir() else {
            return Ok(None);
        };

        let normalized_workdir = utils::path::normalize_macos_private_alias(workdir);
        let normalized_path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        let canonical_workdir = normalized_workdir
            .canonicalize()
            .unwrap_or_else(|_| normalized_workdir.clone());

        if canonical_workdir != normalized_path {
            return Ok(None);
        }

        Ok(Some(normalize_windows_extended_path_prefix(
            canonical_workdir,
        )))
    }

    fn resolve_git_repo_path_with_cli(&self, path: &Path) -> Result<Option<PathBuf>> {
        let output = match GitCli::new().git(path, ["rev-parse", "--show-toplevel"]) {
            Ok(output) => output,
            Err(_) => return Ok(None),
        };
        let top_level = output.trim();
        if top_level.is_empty() {
            return Ok(None);
        }

        let normalized_top_level = utils::path::normalize_macos_private_alias(Path::new(top_level));
        let normalized_path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
        let canonical_top_level = normalized_top_level
            .canonicalize()
            .unwrap_or_else(|_| normalized_top_level.clone());

        if canonical_top_level != normalized_path {
            return Ok(None);
        }

        Ok(Some(normalize_windows_extended_path_prefix(
            canonical_top_level,
        )))
    }

    pub fn validate_git_repo_path(&self, path: &Path) -> Result<()> {
        self.resolve_git_repo_path(path).map(|_| ())
    }

    pub fn normalize_path(&self, path: &str) -> std::io::Result<PathBuf> {
        std::path::absolute(expand_tilde(path)).map(normalize_windows_extended_path_prefix)
    }

    pub async fn register(
        &self,
        pool: &SqlitePool,
        path: &str,
        display_name: Option<&str>,
    ) -> Result<RepoModel> {
        let normalized_path = self.normalize_path(path)?;
        let repo_path = self.resolve_git_repo_path(&normalized_path)?;

        let name = repo_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "unnamed".to_string());

        let display_name = display_name.unwrap_or(&name);

        let repo = RepoModel::find_or_create(pool, &repo_path, display_name).await?;
        Ok(repo)
    }

    pub fn is_git_repo_path(&self, path: &str) -> Result<bool> {
        let normalized_path = self.normalize_path(path)?;

        if !normalized_path.exists() {
            return Err(RepoError::PathNotFound(normalized_path));
        }

        if !normalized_path.is_dir() {
            return Err(RepoError::PathNotDirectory(normalized_path));
        }

        match self.resolve_git_repo_path(&normalized_path) {
            Ok(_) => Ok(true),
            Err(RepoError::NotGitRepository(_)) => Ok(false),
            Err(error) => Err(error),
        }
    }

    pub async fn find_by_id(&self, pool: &SqlitePool, repo_id: Uuid) -> Result<Option<RepoModel>> {
        let repo = RepoModel::find_by_id(pool, repo_id).await?;
        Ok(repo)
    }

    pub async fn get_by_id(&self, pool: &SqlitePool, repo_id: Uuid) -> Result<RepoModel> {
        self.find_by_id(pool, repo_id)
            .await?
            .ok_or(RepoError::NotFound)
    }

    pub async fn init_repo(
        &self,
        pool: &SqlitePool,
        git: &GitService,
        parent_path: &str,
        folder_name: &str,
    ) -> Result<RepoModel> {
        if folder_name.is_empty()
            || folder_name.contains('/')
            || folder_name.contains('\\')
            || folder_name == "."
            || folder_name == ".."
        {
            return Err(RepoError::InvalidFolderName(folder_name.to_string()));
        }

        let normalized_parent = self.normalize_path(parent_path)?;
        if !normalized_parent.exists() {
            return Err(RepoError::PathNotFound(normalized_parent));
        }
        if !normalized_parent.is_dir() {
            return Err(RepoError::PathNotDirectory(normalized_parent));
        }

        let repo_path = normalized_parent.join(folder_name);
        if repo_path.exists() {
            return Err(RepoError::DirectoryAlreadyExists(repo_path));
        }

        git.initialize_repo_with_main_branch(&repo_path)?;

        let repo = RepoModel::find_or_create(pool, &repo_path, folder_name).await?;
        Ok(repo)
    }

    pub async fn init_repo_at_path(
        &self,
        pool: &SqlitePool,
        git: &GitService,
        path: &str,
        display_name: Option<&str>,
    ) -> Result<RepoModel> {
        let normalized_path = self.normalize_path(path)?;
        if !normalized_path.exists() {
            return Err(RepoError::PathNotFound(normalized_path));
        }
        if !normalized_path.is_dir() {
            return Err(RepoError::PathNotDirectory(normalized_path));
        }

        if !normalized_path.join(".git").exists() {
            git.initialize_repo_with_main_branch(&normalized_path)?;
        }

        let default_name = normalized_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "unnamed".to_string());
        let repo_path = self.resolve_git_repo_path(&normalized_path)?;
        let repo =
            RepoModel::find_or_create(pool, &repo_path, display_name.unwrap_or(&default_name))
                .await?;
        Ok(repo)
    }
}

#[cfg(test)]
mod tests {
    use git::GitService;
    use tempfile::TempDir;

    use super::*;

    #[test]
    fn child_directory_inside_parent_repo_is_not_registered_as_parent_repo() {
        let temp = TempDir::new().unwrap();
        let parent_repo = temp.path().join("parent");
        GitService::new()
            .initialize_repo_with_main_branch(&parent_repo)
            .unwrap();
        let child = parent_repo.join("child");
        std::fs::create_dir_all(&child).unwrap();

        let service = RepoService::new();

        assert!(matches!(
            service.resolve_git_repo_path(&child),
            Err(RepoError::NotGitRepository(path)) if path == child
        ));
        assert!(!service.is_git_repo_path(child.to_str().unwrap()).unwrap());
    }

    #[test]
    fn exact_nested_repo_is_registered_as_itself() {
        let temp = TempDir::new().unwrap();
        let parent_repo = temp.path().join("parent");
        GitService::new()
            .initialize_repo_with_main_branch(&parent_repo)
            .unwrap();
        let child_repo = parent_repo.join("child");
        GitService::new()
            .initialize_repo_with_main_branch(&child_repo)
            .unwrap();

        let service = RepoService::new();
        let resolved = service.resolve_git_repo_path(&child_repo).unwrap();
        let expected = normalize_windows_extended_path_prefix(child_repo.canonicalize().unwrap());

        assert_eq!(resolved, expected);
        assert!(
            service
                .is_git_repo_path(child_repo.to_str().unwrap())
                .unwrap()
        );
    }

    #[test]
    fn gitdir_file_repo_is_registered_as_selected_worktree() {
        let temp = TempDir::new().unwrap();
        let repo_path = temp.path().join("worktree");
        GitService::new()
            .initialize_repo_with_main_branch(&repo_path)
            .unwrap();

        let git_dir = repo_path.join(".git");
        let external_git_dir = repo_path.join("repo_git_meta");
        std::fs::rename(&git_dir, &external_git_dir).unwrap();
        std::fs::write(
            &git_dir,
            format!("gitdir: {}\n", external_git_dir.to_string_lossy()),
        )
        .unwrap();

        let service = RepoService::new();
        let resolved = service.resolve_git_repo_path(&repo_path).unwrap();
        let expected = normalize_windows_extended_path_prefix(repo_path.canonicalize().unwrap());

        assert_eq!(resolved, expected);
    }
}
