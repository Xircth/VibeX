use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

use db::models::{
    project::{
        CreateProject, Project, ProjectError, ProjectImportChild, ProjectImportPreview,
        SearchMatchType, SearchResult, UpdateProject,
    },
    project_repo::{CreateProjectRepo, ProjectRepo},
    repo::Repo,
};
use git::GitService;
use sqlx::SqlitePool;
use thiserror::Error;
use utils::path::normalize_windows_extended_path_prefix;
use uuid::Uuid;

use super::{
    file_search::{FileSearchService, SearchQuery},
    repo::{RepoError, RepoService},
};

#[derive(Debug, Error)]
pub enum ProjectServiceError {
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Project(#[from] ProjectError),
    #[error("Path does not exist: {0}")]
    PathNotFound(PathBuf),
    #[error("Path is not a directory: {0}")]
    PathNotDirectory(PathBuf),
    #[error("Path is not a git repository: {0}")]
    NotGitRepository(PathBuf),
    #[error("Duplicate git repository path")]
    DuplicateGitRepoPath,
    #[error("Duplicate repository name in project")]
    DuplicateRepositoryName,
    #[error("Repository not found")]
    RepositoryNotFound,
    #[error("Git operation failed: {0}")]
    GitError(String),
    #[error("Project root path is required")]
    RootPathRequired,
    #[error("Project path is already imported")]
    DuplicateRootPath,
    #[error("Cannot nest a project under itself")]
    InvalidParent,
    #[error("Child path is not inside the parent folder")]
    NotSubpath,
    #[error("Parent project not found")]
    ParentNotFound,
    #[error("A project is one folder. Import extra Git folders as separate projects.")]
    MultiRepoRetired,
}

pub type Result<T> = std::result::Result<T, ProjectServiceError>;

impl From<RepoError> for ProjectServiceError {
    fn from(e: RepoError) -> Self {
        match e {
            RepoError::PathNotFound(p) => Self::PathNotFound(p),
            RepoError::PathNotDirectory(p) => Self::PathNotDirectory(p),
            RepoError::NotGitRepository(p) => Self::NotGitRepository(p),
            RepoError::Io(e) => Self::Io(e),
            RepoError::Database(e) => Self::Database(e),
            _ => Self::RepositoryNotFound,
        }
    }
}

#[derive(Clone, Default)]
pub struct ProjectService;

impl ProjectService {
    pub fn new() -> Self {
        Self
    }

    pub async fn create_project(
        &self,
        pool: &SqlitePool,
        repo_service: &RepoService,
        payload: CreateProject,
    ) -> Result<Project> {
        let mut seen_names = HashSet::new();
        let mut seen_paths = HashSet::new();
        let mut normalized_repos = Vec::new();

        for repo in &payload.repositories {
            let path = repo_service.normalize_path(&repo.git_repo_path)?;
            let repo_path = repo_service.resolve_git_repo_path(&path)?;

            let normalized_path = normalize_windows_extended_path_prefix(&repo_path)
                .to_string_lossy()
                .to_string();

            if !seen_names.insert(repo.display_name.clone()) {
                return Err(ProjectServiceError::DuplicateRepositoryName);
            }

            if !seen_paths.insert(normalized_path.clone()) {
                return Err(ProjectServiceError::DuplicateGitRepoPath);
            }

            normalized_repos.push(CreateProjectRepo {
                display_name: repo.display_name.clone(),
                git_repo_path: normalized_path,
            });
        }

        let root_path = if !payload.root_path.trim().is_empty() {
            normalize_existing_dir(repo_service, &payload.root_path)?
        } else if let Some(first) = normalized_repos.first() {
            first.git_repo_path.clone()
        } else {
            return Err(ProjectServiceError::RootPathRequired);
        };

        if let Some(existing) = Project::find_any_by_root_path(pool, &root_path).await? {
            return self
                .reuse_existing_project(
                    pool,
                    existing,
                    payload.name,
                    payload.parent_project_id,
                    &normalized_repos,
                )
                .await;
        }

        if let Some(parent_id) = payload.parent_project_id {
            self.assert_valid_parent(pool, None, parent_id, &root_path)
                .await?;
        }

        let payload = CreateProject {
            name: payload.name,
            root_path,
            parent_project_id: payload.parent_project_id,
            repositories: payload.repositories,
        };

        let id = Uuid::new_v4();
        let mut project = Project::create(pool, &payload, id)
            .await
            .map_err(|e| ProjectServiceError::Project(ProjectError::CreateFailed(e.to_string())))?;

        for repo in &normalized_repos {
            let repo_entity =
                Repo::find_or_create(pool, Path::new(&repo.git_repo_path), &repo.display_name)
                    .await?;
            ProjectRepo::create(pool, project.id, repo_entity.id).await?;
        }
        project.is_git = !normalized_repos.is_empty();

        project.is_home = utils::path::is_user_home_directory(Path::new(&project.root_path));
        Ok(project)
    }

    pub async fn ensure_home_project(
        &self,
        pool: &SqlitePool,
        repo_service: &RepoService,
    ) -> Result<Project> {
        let home = dirs::home_dir()
            .ok_or_else(|| ProjectServiceError::PathNotFound(PathBuf::from("~")))?;
        self.create_project(
            pool,
            repo_service,
            CreateProject {
                name: "Global".into(),
                root_path: home.to_string_lossy().into_owned(),
                parent_project_id: None,
                repositories: vec![],
            },
        )
        .await
    }

    async fn reuse_existing_project(
        &self,
        pool: &SqlitePool,
        existing: Project,
        name: String,
        parent_project_id: Option<Uuid>,
        repos: &[CreateProjectRepo],
    ) -> Result<Project> {
        let mut project = existing;
        if project.hidden {
            project = Project::set_hidden(pool, project.id, false).await?;
        }
        if !name.trim().is_empty() && name != project.name {
            project = Project::update(
                pool,
                project.id,
                &UpdateProject {
                    name: Some(name),
                    default_main_branch: None,
                },
            )
            .await?;
        }
        if let Some(parent_id) = parent_project_id {
            project = self
                .set_project_parent(pool, project.id, Some(parent_id))
                .await?;
        }
        for repo in repos {
            if ProjectRepo::find_repos_for_project(pool, project.id)
                .await?
                .iter()
                .any(|existing| existing.path.to_string_lossy() == repo.git_repo_path.as_str())
            {
                continue;
            }
            let repo_entity =
                Repo::find_or_create(pool, Path::new(&repo.git_repo_path), &repo.display_name)
                    .await?;
            let _ = ProjectRepo::create(pool, project.id, repo_entity.id).await;
        }
        Ok(Project::find_by_id(pool, project.id)
            .await?
            .ok_or(ProjectError::ProjectNotFound)?)
    }

    pub async fn update_project(
        &self,
        pool: &SqlitePool,
        existing: &Project,
        payload: UpdateProject,
    ) -> Result<Project> {
        let project = Project::update(pool, existing.id, &payload).await?;

        Ok(project)
    }

    pub async fn add_repository(
        &self,
        _pool: &SqlitePool,
        _repo_service: &RepoService,
        _project_id: Uuid,
        _payload: &CreateProjectRepo,
    ) -> Result<Repo> {
        Err(ProjectServiceError::MultiRepoRetired)
    }

    pub async fn delete_repository(
        &self,
        pool: &SqlitePool,
        project_id: Uuid,
        repo_id: Uuid,
    ) -> Result<()> {
        tracing::debug!(
            "Removing repository {} from project {}",
            repo_id,
            project_id
        );

        ProjectRepo::remove_repo_from_project(pool, project_id, repo_id)
            .await
            .map_err(|e| match e {
                db::models::project_repo::ProjectRepoError::NotFound => {
                    ProjectServiceError::RepositoryNotFound
                }
                db::models::project_repo::ProjectRepoError::Database(e) => {
                    ProjectServiceError::Database(e)
                }
                _ => ProjectServiceError::RepositoryNotFound,
            })?;

        if let Err(e) = Repo::delete_orphaned(pool).await {
            tracing::error!("Failed to delete orphaned repos: {}", e);
        }

        tracing::info!("Removed repository {} from project {}", repo_id, project_id);

        Ok(())
    }

    pub async fn delete_project(&self, pool: &SqlitePool, project_id: Uuid) -> Result<u64> {
        let rows_affected = Project::delete(pool, project_id).await?;

        if let Err(e) = Repo::delete_orphaned(pool).await {
            tracing::error!("Failed to delete orphaned repos: {}", e);
        }

        Ok(rows_affected)
    }

    pub async fn get_repositories(&self, pool: &SqlitePool, project_id: Uuid) -> Result<Vec<Repo>> {
        let repos = ProjectRepo::find_repos_for_project(pool, project_id).await?;
        Ok(repos)
    }

    pub async fn search_files(
        &self,
        file_search: &FileSearchService,
        repositories: &[Repo],
        query: &SearchQuery,
    ) -> Result<Vec<SearchResult>> {
        let query_str = query.q.trim();
        if query_str.is_empty() || repositories.is_empty() {
            return Ok(vec![]);
        }

        // Search in parallel and prefix paths with repo name
        let search_futures: Vec<_> = repositories
            .iter()
            .map(|repo| {
                let repo_name = repo.name.clone();
                let repo_path = repo.path.clone();
                let mode = query.mode.clone();
                let query_str = query_str.to_string();
                async move {
                    let results = file_search
                        .search_repo(&repo_path, &query_str, mode)
                        .await?;
                    Ok::<_, String>((repo_name, results))
                }
            })
            .collect();

        let repo_results = futures::future::try_join_all(search_futures)
            .await
            .map_err(ProjectServiceError::GitError)?;

        let mut all_results: Vec<SearchResult> = repo_results
            .into_iter()
            .flat_map(|(repo_name, results)| {
                results.into_iter().map(move |r| SearchResult {
                    path: format!("{}/{}", repo_name, r.path),
                    is_file: r.is_file,
                    match_type: r.match_type.clone(),
                    score: r.score,
                })
            })
            .collect();

        all_results.sort_by(|a, b| {
            let priority = |m: &SearchMatchType| match m {
                SearchMatchType::FileName => 0,
                SearchMatchType::DirectoryName => 1,
                SearchMatchType::FullPath => 2,
            };
            priority(&a.match_type)
                .cmp(&priority(&b.match_type))
                .then_with(|| b.score.cmp(&a.score)) // Higher scores first
        });

        all_results.truncate(10);
        Ok(all_results)
    }

    pub async fn preview_import(
        &self,
        pool: &SqlitePool,
        repo_service: &RepoService,
        path: &str,
    ) -> Result<ProjectImportPreview> {
        let root = normalize_existing_dir(repo_service, path)?;
        let root_path = PathBuf::from(&root);
        let is_git = root_path.join(".git").exists();
        let mut children = Vec::new();
        let entries = std::fs::read_dir(&root_path)?;
        for entry in entries.flatten() {
            let child_path = entry.path();
            let Some(name) = child_path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if name.starts_with('.') || name.eq_ignore_ascii_case("node_modules") {
                continue;
            }
            if !child_path.is_dir() || !child_path.join(".git").exists() {
                continue;
            }
            let normalized = normalize_windows_extended_path_prefix(&child_path)
                .to_string_lossy()
                .to_string();
            let existing = Project::find_any_by_root_path(pool, &normalized)
                .await?
                .map(|project| project.id);
            children.push(ProjectImportChild {
                name: name.to_string(),
                path: normalized,
                existing_project_id: existing,
            });
        }
        children.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        Ok(ProjectImportPreview {
            path: root,
            is_git,
            children,
        })
    }

    pub async fn hide_project(&self, pool: &SqlitePool, project_id: Uuid) -> Result<Project> {
        let project = Project::find_by_id(pool, project_id)
            .await?
            .ok_or(ProjectError::ProjectNotFound)?;
        Project::clear_parent_for_children(pool, project.id).await?;
        Ok(Project::set_hidden(pool, project.id, true).await?)
    }

    pub async fn set_project_parent(
        &self,
        pool: &SqlitePool,
        project_id: Uuid,
        parent_project_id: Option<Uuid>,
    ) -> Result<Project> {
        let project = Project::find_by_id(pool, project_id)
            .await?
            .ok_or(ProjectError::ProjectNotFound)?;
        if let Some(parent_id) = parent_project_id {
            self.assert_valid_parent(pool, Some(project.id), parent_id, &project.root_path)
                .await?;
        }
        Ok(Project::set_parent(pool, project.id, parent_project_id).await?)
    }

    pub async fn init_project_git(
        &self,
        pool: &SqlitePool,
        repo_service: &RepoService,
        git: &GitService,
        project_id: Uuid,
    ) -> Result<Project> {
        let project = Project::find_by_id(pool, project_id)
            .await?
            .ok_or(ProjectError::ProjectNotFound)?;
        if project.root_path.is_empty() {
            return Err(ProjectServiceError::RootPathRequired);
        }
        repo_service
            .init_repo_at_path(pool, git, &project.root_path, Some(&project.name))
            .await?;
        let repos = ProjectRepo::find_repos_for_project(pool, project.id).await?;
        if repos.is_empty() {
            let repo =
                Repo::find_or_create(pool, Path::new(&project.root_path), &project.name).await?;
            ProjectRepo::create(pool, project.id, repo.id).await?;
        }
        Ok(Project::find_by_id(pool, project.id)
            .await?
            .ok_or(ProjectError::ProjectNotFound)?)
    }

    pub async fn git_children(&self, pool: &SqlitePool, project_id: Uuid) -> Result<Vec<Project>> {
        Ok(Project::find_git_children(pool, project_id).await?)
    }

    pub async fn migrate_multi_repo_projects(
        &self,
        pool: &SqlitePool,
        repo_service: &RepoService,
    ) -> Result<()> {
        if !Project::has_multi_repo_project(pool).await? {
            return Ok(());
        }

        let projects = Project::find_all_including_hidden(pool).await?;
        for project in projects {
            let repos = ProjectRepo::find_repos_for_project(pool, project.id).await?;
            if repos.len() <= 1 {
                continue;
            }
            let paths: Vec<PathBuf> = repos.iter().map(|repo| repo.path.clone()).collect();
            if let Some(container) = containing_repo_path(&paths) {
                let container_repo = repos
                    .iter()
                    .find(|repo| repo.path == container)
                    .expect("container path is one of the repos");
                let parent = self
                    .create_project(
                        pool,
                        repo_service,
                        CreateProject {
                            name: container_repo.display_name.clone(),
                            root_path: container.to_string_lossy().into_owned(),
                            parent_project_id: None,
                            repositories: vec![CreateProjectRepo {
                                display_name: container_repo.display_name.clone(),
                                git_repo_path: container.to_string_lossy().into_owned(),
                            }],
                        },
                    )
                    .await?;
                for repo in &repos {
                    if repo.path == container {
                        continue;
                    }
                    let _ = self
                        .create_project(
                            pool,
                            repo_service,
                            CreateProject {
                                name: repo.display_name.clone(),
                                root_path: repo.path.to_string_lossy().into_owned(),
                                parent_project_id: Some(parent.id),
                                repositories: vec![CreateProjectRepo {
                                    display_name: repo.display_name.clone(),
                                    git_repo_path: repo.path.to_string_lossy().into_owned(),
                                }],
                            },
                        )
                        .await;
                    sqlx::query("DELETE FROM project_repos WHERE project_id = ? AND repo_id = ?")
                        .bind(project.id)
                        .bind(repo.id)
                        .execute(pool)
                        .await?;
                }
                continue;
            }

            if let Some(common) = common_parent_dir(&paths) {
                let parent = self
                    .create_project(
                        pool,
                        repo_service,
                        CreateProject {
                            name: folder_name(&common),
                            root_path: common.to_string_lossy().into_owned(),
                            parent_project_id: None,
                            repositories: vec![],
                        },
                    )
                    .await?;
                for repo in &repos {
                    let child = self
                        .create_project(
                            pool,
                            repo_service,
                            CreateProject {
                                name: repo.display_name.clone(),
                                root_path: repo.path.to_string_lossy().into_owned(),
                                parent_project_id: Some(parent.id),
                                repositories: vec![CreateProjectRepo {
                                    display_name: repo.display_name.clone(),
                                    git_repo_path: repo.path.to_string_lossy().into_owned(),
                                }],
                            },
                        )
                        .await?;
                    if child.id != project.id {
                        sqlx::query(
                            "DELETE FROM project_repos WHERE project_id = ? AND repo_id = ?",
                        )
                        .bind(project.id)
                        .bind(repo.id)
                        .execute(pool)
                        .await?;
                    }
                }
                self.keep_only_root_repo(pool, project.id).await?;
                continue;
            }

            for repo in repos.iter().skip(1) {
                let _ = self
                    .create_project(
                        pool,
                        repo_service,
                        CreateProject {
                            name: repo.display_name.clone(),
                            root_path: repo.path.to_string_lossy().into_owned(),
                            parent_project_id: None,
                            repositories: vec![CreateProjectRepo {
                                display_name: repo.display_name.clone(),
                                git_repo_path: repo.path.to_string_lossy().into_owned(),
                            }],
                        },
                    )
                    .await;
                sqlx::query("DELETE FROM project_repos WHERE project_id = ? AND repo_id = ?")
                    .bind(project.id)
                    .bind(repo.id)
                    .execute(pool)
                    .await?;
            }
        }
        Ok(())
    }

    async fn keep_only_root_repo(&self, pool: &SqlitePool, project_id: Uuid) -> Result<()> {
        let Some(project) = Project::find_by_id(pool, project_id).await? else {
            return Ok(());
        };
        let repos = ProjectRepo::find_repos_for_project(pool, project_id).await?;
        for repo in repos {
            if repo.path.to_string_lossy() != project.root_path {
                sqlx::query("DELETE FROM project_repos WHERE project_id = ? AND repo_id = ?")
                    .bind(project_id)
                    .bind(repo.id)
                    .execute(pool)
                    .await?;
            }
        }
        Ok(())
    }

    async fn assert_valid_parent(
        &self,
        pool: &SqlitePool,
        child_id: Option<Uuid>,
        parent_id: Uuid,
        child_root: &str,
    ) -> Result<()> {
        if child_id == Some(parent_id) {
            return Err(ProjectServiceError::InvalidParent);
        }
        let parent = Project::find_by_id(pool, parent_id)
            .await?
            .ok_or(ProjectServiceError::ParentNotFound)?;
        if parent.hidden {
            return Err(ProjectServiceError::ParentNotFound);
        }
        if !is_strict_subpath(child_root, &parent.root_path) {
            return Err(ProjectServiceError::NotSubpath);
        }
        let mut cursor = Some(parent_id);
        while let Some(current) = cursor {
            if child_id == Some(current) {
                return Err(ProjectServiceError::InvalidParent);
            }
            cursor = Project::find_by_id(pool, current)
                .await?
                .and_then(|project| project.parent_project_id);
        }
        Ok(())
    }
}

fn normalize_existing_dir(repo_service: &RepoService, path: &str) -> Result<String> {
    let normalized = repo_service.normalize_path(path)?;
    if !normalized.exists() {
        return Err(ProjectServiceError::PathNotFound(normalized));
    }
    if !normalized.is_dir() {
        return Err(ProjectServiceError::PathNotDirectory(normalized));
    }
    Ok(normalize_windows_extended_path_prefix(&normalized)
        .to_string_lossy()
        .to_string())
}

fn is_strict_subpath(child: &str, parent: &str) -> bool {
    let child = PathBuf::from(child);
    let parent = PathBuf::from(parent);
    if parent.as_os_str().is_empty() || child == parent {
        return false;
    }
    child.starts_with(&parent)
}

fn folder_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn containing_repo_path(paths: &[PathBuf]) -> Option<PathBuf> {
    paths.iter().find_map(|candidate| {
        let contains_all = paths
            .iter()
            .all(|path| path == candidate || path.starts_with(candidate) && path != candidate);
        contains_all.then(|| candidate.clone())
    })
}

fn common_parent_dir(paths: &[PathBuf]) -> Option<PathBuf> {
    let mut common = paths.first()?.parent()?.to_path_buf();
    for path in paths.iter().skip(1) {
        while !path.starts_with(&common) {
            common = common.parent()?.to_path_buf();
        }
    }
    if is_filesystem_root(&common) {
        return None;
    }
    Some(normalize_windows_extended_path_prefix(common))
}

fn is_filesystem_root(path: &Path) -> bool {
    path.parent().is_none()
        || path
            .components()
            .filter(|component| matches!(component, std::path::Component::Normal(_)))
            .count()
            < 2
}
