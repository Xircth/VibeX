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
        .preview_import(
            &pool,
            &RepoService::new(),
            parent.to_str().unwrap(),
        )
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
