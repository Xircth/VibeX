use std::fs;

use db::models::project::CreateProject;
use git::GitService;
use services::services::{project::ProjectService, repo::RepoService};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use tempfile::TempDir;

async fn pool() -> sqlx::SqlitePool {
    let options = SqliteConnectOptions::new()
        .filename(":memory:")
        .create_if_missing(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .unwrap();
    sqlx::migrate!("../db/migrations").run(&pool).await.unwrap();
    pool
}

#[tokio::test]
async fn creates_non_git_project_without_initializing_git() {
    let root = TempDir::new().unwrap();
    let folder = root.path().join("notes");
    fs::create_dir_all(&folder).unwrap();
    fs::write(folder.join("readme.txt"), "hi").unwrap();

    let pool = pool().await;
    let project = ProjectService::new()
        .create_project(
            &pool,
            &RepoService::new(),
            CreateProject {
                name: "notes".into(),
                root_path: folder.to_string_lossy().into_owned(),
                parent_project_id: None,
                repositories: vec![],
            },
        )
        .await
        .unwrap();

    assert!(!project.is_git);
    assert!(!folder.join(".git").exists());
    assert_eq!(project.hidden, false);
}

#[tokio::test]
async fn ensure_home_project_is_idempotent_non_git_folder() {
    let pool = pool().await;
    let first = ProjectService::new()
        .ensure_home_project(&pool, &RepoService::new())
        .await
        .unwrap();
    let second = ProjectService::new()
        .ensure_home_project(&pool, &RepoService::new())
        .await
        .unwrap();

    assert_eq!(first.id, second.id);
    assert!(!first.is_git);
    assert!(first.is_home);
    assert!(!first.root_path.is_empty());
}

#[tokio::test]
async fn preview_import_lists_only_direct_git_children() {
    let root = TempDir::new().unwrap();
    let parent = root.path().join("mono");
    let api = parent.join("api");
    let nested = parent.join("pkg").join("deep");
    fs::create_dir_all(&api).unwrap();
    fs::create_dir_all(&nested).unwrap();
    GitService::new()
        .initialize_repo_with_main_branch(&api)
        .unwrap();
    GitService::new()
        .initialize_repo_with_main_branch(&nested)
        .unwrap();

    let pool = pool().await;
    let preview = ProjectService::new()
        .preview_import(&pool, &RepoService::new(), parent.to_str().unwrap())
        .await
        .unwrap();

    assert!(!preview.is_git);
    assert_eq!(preview.children.len(), 1);
    assert_eq!(preview.children[0].name, "api");
}

#[tokio::test]
async fn hide_releases_direct_children_and_keeps_grandchildren() {
    let root = TempDir::new().unwrap();
    let a = root.path().join("A");
    let b = a.join("B");
    let c = b.join("C");
    fs::create_dir_all(&c).unwrap();
    GitService::new()
        .initialize_repo_with_main_branch(&b)
        .unwrap();
    GitService::new()
        .initialize_repo_with_main_branch(&c)
        .unwrap();

    let pool = pool().await;
    let service = ProjectService::new();
    let repo = RepoService::new();
    let project_a = service
        .create_project(
            &pool,
            &repo,
            CreateProject {
                name: "A".into(),
                root_path: a.to_string_lossy().into_owned(),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let project_b = service
        .create_project(
            &pool,
            &repo,
            CreateProject {
                name: "B".into(),
                root_path: b.to_string_lossy().into_owned(),
                parent_project_id: Some(project_a.id),
                repositories: vec![db::models::project_repo::CreateProjectRepo {
                    display_name: "B".into(),
                    git_repo_path: b.to_string_lossy().into_owned(),
                }],
            },
        )
        .await
        .unwrap();
    let _project_c = service
        .create_project(
            &pool,
            &repo,
            CreateProject {
                name: "C".into(),
                root_path: c.to_string_lossy().into_owned(),
                parent_project_id: Some(project_b.id),
                repositories: vec![db::models::project_repo::CreateProjectRepo {
                    display_name: "C".into(),
                    git_repo_path: c.to_string_lossy().into_owned(),
                }],
            },
        )
        .await
        .unwrap();

    service.hide_project(&pool, project_a.id).await.unwrap();
    let visible = db::models::project::Project::find_all(&pool).await.unwrap();
    assert!(visible.iter().all(|project| project.id != project_a.id));
    let b = visible.iter().find(|project| project.name == "B").unwrap();
    assert!(b.parent_project_id.is_none());
    let c = visible.iter().find(|project| project.name == "C").unwrap();
    assert_eq!(c.parent_project_id, Some(project_b.id));
}

#[tokio::test]
async fn migrate_splits_sibling_repos_under_shared_parent() {
    let root = TempDir::new().unwrap();
    let parent = root.path().join("mono");
    let api = parent.join("api");
    let web = parent.join("web");
    fs::create_dir_all(&api).unwrap();
    fs::create_dir_all(&web).unwrap();
    GitService::new()
        .initialize_repo_with_main_branch(&api)
        .unwrap();
    GitService::new()
        .initialize_repo_with_main_branch(&web)
        .unwrap();

    let pool = pool().await;
    let service = ProjectService::new();
    let repo = RepoService::new();
    service
        .create_project(
            &pool,
            &repo,
            CreateProject {
                name: "legacy-multi".into(),
                repositories: vec![
                    db::models::project_repo::CreateProjectRepo {
                        display_name: "api".into(),
                        git_repo_path: api.to_string_lossy().into_owned(),
                    },
                    db::models::project_repo::CreateProjectRepo {
                        display_name: "web".into(),
                        git_repo_path: web.to_string_lossy().into_owned(),
                    },
                ],
                ..Default::default()
            },
        )
        .await
        .unwrap();

    service
        .migrate_multi_repo_projects(&pool, &repo)
        .await
        .unwrap();
    service
        .migrate_multi_repo_projects(&pool, &repo)
        .await
        .unwrap();

    let visible = db::models::project::Project::find_all(&pool).await.unwrap();
    let folder = visible
        .iter()
        .find(|project| !project.is_git)
        .expect("shared parent folder");
    let children: Vec<_> = visible
        .iter()
        .filter(|project| project.parent_project_id == Some(folder.id))
        .collect();
    assert_eq!(children.len(), 2);
    assert!(children.iter().all(|project| project.is_git));
    assert!(
        !db::models::project::Project::has_multi_repo_project(&pool)
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn migrate_keeps_containing_repo_as_parent() {
    let root = TempDir::new().unwrap();
    let outer = root.path().join("outer");
    let inner = outer.join("inner");
    fs::create_dir_all(&inner).unwrap();
    GitService::new()
        .initialize_repo_with_main_branch(&outer)
        .unwrap();
    GitService::new()
        .initialize_repo_with_main_branch(&inner)
        .unwrap();

    let pool = pool().await;
    let service = ProjectService::new();
    let repo = RepoService::new();
    let original = service
        .create_project(
            &pool,
            &repo,
            CreateProject {
                name: "outer".into(),
                repositories: vec![
                    db::models::project_repo::CreateProjectRepo {
                        display_name: "outer".into(),
                        git_repo_path: outer.to_string_lossy().into_owned(),
                    },
                    db::models::project_repo::CreateProjectRepo {
                        display_name: "inner".into(),
                        git_repo_path: inner.to_string_lossy().into_owned(),
                    },
                ],
                ..Default::default()
            },
        )
        .await
        .unwrap();

    service
        .migrate_multi_repo_projects(&pool, &repo)
        .await
        .unwrap();

    let visible = db::models::project::Project::find_all(&pool).await.unwrap();
    let parent = visible
        .iter()
        .find(|project| project.id == original.id)
        .unwrap();
    assert!(parent.is_git);
    assert!(parent.parent_project_id.is_none());
    let inner_project = visible
        .iter()
        .find(|project| project.name == "inner")
        .unwrap();
    assert_eq!(inner_project.parent_project_id, Some(parent.id));
    assert_eq!(
        db::models::project_repo::ProjectRepo::find_repos_for_project(&pool, parent.id)
            .await
            .unwrap()
            .len(),
        1
    );
}
