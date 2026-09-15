use std::collections::BTreeSet;

use agents::{
    HistoryPathDestination, HistoryScanEntry, LocalHistoryDestination, LocalHistoryScanPage,
    build_local_history_scan_page,
};
use db::models::{
    project::Project,
    project_repo::ProjectRepo,
    repo::Repo,
    task::{CreateTask, Task, TaskStatus},
    workspace::{CreateWorkspace, Workspace, WorkspaceError},
    workspace_repo::{CreateWorkspaceRepo, WorkspaceRepo},
};
use sqlx::SqlitePool;
use uuid::Uuid;

pub async fn assemble_local_history_scan_page(
    pool: &SqlitePool,
    sessions: Vec<HistoryScanEntry>,
) -> Result<LocalHistoryScanPage, sqlx::Error> {
    let imported = load_imported_history_keys(pool).await?;
    let (destinations, project_destinations) = load_history_destinations(pool).await?;
    Ok(build_local_history_scan_page(
        sessions,
        &imported,
        &destinations,
        project_destinations,
    ))
}

async fn load_imported_history_keys(
    pool: &SqlitePool,
) -> Result<BTreeSet<(String, String)>, sqlx::Error> {
    let rows = sqlx::query_as::<_, (Option<String>, Option<String>)>(
        r#"SELECT agent_id, external_session_id
           FROM sessions
           WHERE deleted_at IS NULL
             AND agent_id IS NOT NULL
             AND external_session_id IS NOT NULL"#,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|(agent_id, external_id)| Some((agent_id?, external_id?)))
        .collect())
}

async fn load_history_destinations(
    pool: &SqlitePool,
) -> Result<(Vec<HistoryPathDestination>, Vec<LocalHistoryDestination>), sqlx::Error> {
    let projects = Project::find_all(pool).await?;
    let mut destinations = Vec::new();
    let mut project_destinations = Vec::new();

    for project in &projects {
        let repos = ProjectRepo::find_repos_for_project(pool, project.id).await?;
        let workspaces = fetch_live_workspaces(pool, project.id).await?;
        let default_workspace = match pick_project_root_workspace(&workspaces) {
            Some(workspace) => workspace.clone(),
            None => match ensure_project_root_workspace_for_import(pool, project, &repos).await {
                Ok(workspace) => workspace,
                Err(error) => {
                    tracing::warn!(
                        project_id = %project.id,
                        %error,
                        "skipped local-history destination for project without a usable workspace"
                    );
                    continue;
                }
            },
        };

        project_destinations.push(LocalHistoryDestination {
            project_id: project.id,
            project_name: project.name.clone(),
            workspace_id: default_workspace.id,
            workspace_name: default_workspace
                .name
                .clone()
                .or_else(|| Some(default_workspace.branch.clone())),
        });

        let mut seen_paths = BTreeSet::new();
        for workspace in workspaces.iter().chain(std::iter::once(&default_workspace)) {
            if let Some(path) = workspace
                .container_ref
                .as_deref()
                .filter(|path| !path.trim().is_empty())
                && seen_paths.insert(path.to_string())
            {
                destinations.push(HistoryPathDestination {
                    path: path.to_string(),
                    project_id: project.id,
                    project_name: project.name.clone(),
                    workspace_id: workspace.id,
                });
            }
        }
        for repo in &repos {
            let path = repo.path.to_string_lossy().to_string();
            if path.trim().is_empty() || !seen_paths.insert(path.clone()) {
                continue;
            }
            destinations.push(HistoryPathDestination {
                path,
                project_id: project.id,
                project_name: project.name.clone(),
                workspace_id: default_workspace.id,
            });
        }
    }

    Ok((destinations, project_destinations))
}

async fn fetch_live_workspaces(
    pool: &SqlitePool,
    project_id: Uuid,
) -> Result<Vec<Workspace>, sqlx::Error> {
    let workspaces = Workspace::fetch_by_project_id(pool, project_id)
        .await
        .map_err(workspace_db_error)?;
    Ok(workspaces
        .into_iter()
        .filter(|workspace| !workspace.archived)
        .collect())
}

fn pick_project_root_workspace(workspaces: &[Workspace]) -> Option<&Workspace> {
    workspaces
        .iter()
        .find(|workspace| !workspace.use_worktree)
}

async fn ensure_project_root_workspace_for_import(
    pool: &SqlitePool,
    project: &Project,
    repos: &[Repo],
) -> Result<Workspace, sqlx::Error> {
    let Some(primary) = repos.first() else {
        return Err(sqlx::Error::RowNotFound);
    };
    let branch = project
        .default_main_branch
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("main")
        .to_string();
    let workspace_repos = [CreateWorkspaceRepo {
        repo_id: primary.id,
        target_branch: branch.clone(),
    }];
    if let Some(workspace_id) =
        WorkspaceRepo::find_reusable_non_worktree_workspace_id(pool, project.id, &workspace_repos)
            .await?
        && let Some(workspace) = Workspace::find_by_id(pool, workspace_id).await?
    {
        return Ok(workspace);
    }
    // Imported projects can exist before any conversation is created. Session
    // import still needs a destination workspace, so create the project-root
    // workspace here instead of requiring a prior chat.
    let task = if let Some(existing) =
        Task::find_by_project_id_with_attempt_status(pool, project.id)
            .await?
            .into_iter()
            .next()
    {
        existing.task
    } else {
        Task::create(
            pool,
            &CreateTask {
                project_id: project.id,
                title: format!("Project Root Workspace ({})", primary.name),
                description: Some(
                    "Auto-created to support sessions on the project root branch.".to_string(),
                ),
                status: Some(TaskStatus::Todo),
                parent_workspace_id: None,
                image_ids: None,
            },
            Uuid::new_v4(),
        )
        .await?
    };
    let workspace = Workspace::create(
        pool,
        &CreateWorkspace {
            project_id: project.id,
            parent_workspace_id: None,
            branch: branch.clone(),
            container_ref: Some(primary.path.to_string_lossy().to_string()),
            use_worktree: false,
            agent_working_dir: primary.default_working_dir.clone(),
        },
        Uuid::new_v4(),
        task.id,
    )
    .await
    .map_err(workspace_db_error)?;
    WorkspaceRepo::create_many(pool, workspace.id, &workspace_repos).await?;
    let display_name = if primary.display_name.trim().is_empty() {
        primary.name.as_str()
    } else {
        primary.display_name.as_str()
    };
    let workspace_name = format!("{display_name} · {branch}");
    Workspace::update(
        pool,
        workspace.id,
        Some(false),
        None,
        Some(workspace_name.as_str()),
    )
    .await?;
    Workspace::find_by_id(pool, workspace.id)
        .await?
        .ok_or(sqlx::Error::RowNotFound)
}

fn workspace_db_error(error: WorkspaceError) -> sqlx::Error {
    match error {
        WorkspaceError::Database(error) => error,
        other => sqlx::Error::Protocol(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use agents::{AgentKind, HistoryScanEntry};
    use db::models::project::CreateProject;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use uuid::Uuid;

    use super::*;

    async fn migrated_pool() -> SqlitePool {
        let options = SqliteConnectOptions::from_str("sqlite::memory:")
            .expect("sqlite options")
            .foreign_keys(false);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .expect("memory db");
        sqlx::migrate!("../db/migrations")
            .run(&pool)
            .await
            .expect("run migrations");
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&pool)
            .await
            .expect("disable foreign keys");
        pool
    }

    #[tokio::test]
    async fn imported_project_without_conversations_is_an_import_destination() {
        let pool = migrated_pool().await;
        let project_id = Uuid::new_v4();
        Project::create(
            &pool,
            &CreateProject {
                name: "VibeX".into(),
                repositories: Vec::new(),
            },
            project_id,
        )
        .await
        .expect("create project");
        let repo = Repo::find_or_create(
            &pool,
            std::path::Path::new("/Users/mac/Projects/VibeX"),
            "VibeX",
        )
        .await
        .expect("create repo");
        ProjectRepo::create(&pool, project_id, repo.id)
            .await
            .expect("link repo");

        let page = assemble_local_history_scan_page(
            &pool,
            vec![HistoryScanEntry {
                source_agent: AgentKind::Codex,
                external_session_id: "codex-1".into(),
                title: Some("Local Codex".into()),
                workspace_path: Some(std::path::PathBuf::from("/Users/mac/Projects/VibeX")),
                message_count: 2,
                updated_at: None,
            }],
        )
        .await
        .expect("scan page");

        assert_eq!(page.folders.len(), 1);
        assert_eq!(page.destinations.len(), 1);
        assert_eq!(page.destinations[0].project_id, project_id);
        assert_eq!(page.folders[0].project_id, Some(project_id));
        assert!(page.folders[0].workspace_id.is_some());
        assert_eq!(
            page.folders[0].workspace_id,
            Some(page.destinations[0].workspace_id)
        );
        assert_eq!(page.importable_count, 1);
    }

    #[tokio::test]
    async fn existing_project_root_workspace_is_reused_as_the_import_destination() {
        let pool = migrated_pool().await;
        let project_id = Uuid::new_v4();
        Project::create(
            &pool,
            &CreateProject {
                name: "VibeX".into(),
                repositories: Vec::new(),
            },
            project_id,
        )
        .await
        .expect("create project");
        let repo = Repo::find_or_create(
            &pool,
            std::path::Path::new("/Users/mac/Projects/VibeX"),
            "VibeX",
        )
        .await
        .expect("create repo");
        ProjectRepo::create(&pool, project_id, repo.id)
            .await
            .expect("link repo");
        let task = Task::create(
            &pool,
            &CreateTask {
                project_id,
                title: "Existing root".into(),
                description: None,
                status: Some(TaskStatus::Todo),
                parent_workspace_id: None,
                image_ids: None,
            },
            Uuid::new_v4(),
        )
        .await
        .expect("create task");
        let workspace = Workspace::create(
            &pool,
            &CreateWorkspace {
                project_id,
                parent_workspace_id: None,
                branch: "main".into(),
                container_ref: Some("/Users/mac/Projects/VibeX".into()),
                use_worktree: false,
                agent_working_dir: None,
            },
            Uuid::new_v4(),
            task.id,
        )
        .await
        .expect("create workspace");

        let page = assemble_local_history_scan_page(
            &pool,
            vec![HistoryScanEntry {
                source_agent: AgentKind::Codex,
                external_session_id: "codex-1".into(),
                title: Some("Local Codex".into()),
                workspace_path: Some(std::path::PathBuf::from(
                    "/private/Users/mac/Projects/VibeX",
                )),
                message_count: 2,
                updated_at: None,
            }],
        )
        .await
        .expect("scan page");

        assert_eq!(page.destinations.len(), 1);
        assert_eq!(page.destinations[0].workspace_id, workspace.id);
        assert_eq!(page.folders[0].workspace_id, Some(workspace.id));
        assert_eq!(
            Workspace::fetch_by_project_id(&pool, project_id)
                .await
                .expect("list workspaces")
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn worktree_only_project_still_gets_a_project_root_destination() {
        let pool = migrated_pool().await;
        let project_id = Uuid::new_v4();
        Project::create(
            &pool,
            &CreateProject {
                name: "VibeX".into(),
                repositories: Vec::new(),
            },
            project_id,
        )
        .await
        .expect("create project");
        let repo = Repo::find_or_create(
            &pool,
            std::path::Path::new("/Users/mac/Projects/VibeX"),
            "VibeX",
        )
        .await
        .expect("create repo");
        ProjectRepo::create(&pool, project_id, repo.id)
            .await
            .expect("link repo");
        let task = Task::create(
            &pool,
            &CreateTask {
                project_id,
                title: "Feature worktree".into(),
                description: None,
                status: Some(TaskStatus::Todo),
                parent_workspace_id: None,
                image_ids: None,
            },
            Uuid::new_v4(),
        )
        .await
        .expect("create task");
        let worktree = Workspace::create(
            &pool,
            &CreateWorkspace {
                project_id,
                parent_workspace_id: None,
                branch: "feature".into(),
                container_ref: Some("/Users/mac/Projects/VibeX/.worktrees/feature".into()),
                use_worktree: true,
                agent_working_dir: None,
            },
            Uuid::new_v4(),
            task.id,
        )
        .await
        .expect("create worktree");

        let page = assemble_local_history_scan_page(
            &pool,
            vec![
                HistoryScanEntry {
                    source_agent: AgentKind::Codex,
                    external_session_id: "codex-root".into(),
                    title: Some("Root session".into()),
                    workspace_path: Some(std::path::PathBuf::from("/Users/mac/Projects/VibeX")),
                    message_count: 2,
                    updated_at: None,
                },
                HistoryScanEntry {
                    source_agent: AgentKind::Codex,
                    external_session_id: "codex-tree".into(),
                    title: Some("Worktree session".into()),
                    workspace_path: Some(std::path::PathBuf::from(
                        "/Users/mac/Projects/VibeX/.worktrees/feature",
                    )),
                    message_count: 1,
                    updated_at: None,
                },
            ],
        )
        .await
        .expect("scan page");

        assert_eq!(page.destinations.len(), 1);
        assert_ne!(page.destinations[0].workspace_id, worktree.id);
        let root = page
            .folders
            .iter()
            .find(|folder| folder.path == "/Users/mac/Projects/VibeX")
            .expect("root folder");
        let tree = page
            .folders
            .iter()
            .find(|folder| folder.path.ends_with("feature"))
            .expect("worktree folder");
        assert_eq!(root.workspace_id, Some(page.destinations[0].workspace_id));
        assert_eq!(tree.workspace_id, Some(worktree.id));
        assert_eq!(
            Workspace::fetch_by_project_id(&pool, project_id)
                .await
                .expect("list workspaces")
                .len(),
            2
        );
    }
}
