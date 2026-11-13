use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use db::{
    DBService,
    models::{
        execution_process::{ExecutionProcess, ExecutionProcessStatus},
        execution_process_repo_state::{
            CreateExecutionProcessRepoState, ExecutionProcessRepoState,
        },
        repo::Repo,
        workspace::Workspace,
    },
};
use executors::actions::{
    ExecutorAction, ExecutorActionType,
    script::{ScriptContext, ScriptRequest, ScriptRequestLanguage},
};
use git::{GitCli, GitService};
use services::services::{
    config::Config, image::ImageService, notification::NotificationService,
    workspace_manager::WorkspaceManager, worktree_manager::WorktreeManager,
};
use sqlx::{SqlitePool, types::chrono::Utc};
use tempfile::TempDir;
use tokio::sync::RwLock;
use utils::msg_store::MsgStore;
use uuid::Uuid;

use super::{ContainerService, LocalContainerService};

fn sample_workspace(
    container_ref: Option<&str>,
    use_worktree: bool,
    agent_working_dir: Option<&str>,
) -> Workspace {
    Workspace {
        id: Uuid::new_v4(),
        project_id: Uuid::new_v4(),
        task_id: Uuid::new_v4(),
        parent_workspace_id: None,
        container_ref: container_ref.map(ToOwned::to_owned),
        branch: "feature/worktree".to_string(),
        use_worktree,
        agent_working_dir: agent_working_dir.map(ToOwned::to_owned),
        setup_completed_at: None,
        created_at: Utc::now(),
        updated_at: Utc::now(),
        archived: false,
        pinned: false,
        name: None,
    }
}

fn sample_repo(name: &str, path: &str) -> Repo {
    Repo {
        id: Uuid::new_v4(),
        path: PathBuf::from(path),
        name: name.to_string(),
        display_name: name.to_string(),
        setup_script: None,
        cleanup_script: None,
        archive_script: None,
        copy_files: None,
        parallel_setup_script: false,
        dev_server_script: None,
        default_target_branch: None,
        default_working_dir: None,
        created_at: Utc::now(),
        updated_at: Utc::now(),
    }
}

fn configure_commit_identity(repo_path: &Path) {
    let git = GitCli::new();
    git.git(repo_path, ["config", "user.name", "Test User"])
        .expect("set test git user.name");
    git.git(repo_path, ["config", "user.email", "test@example.com"])
        .expect("set test git user.email");
}

fn seed_committed_repo(git: &GitService, repo_path: &Path) {
    git.initialize_repo_with_main_branch(repo_path).unwrap();
    configure_commit_identity(repo_path);
    fs::write(repo_path.join("README.md"), "hello\n").unwrap();
    git.commit(repo_path, "seed").unwrap();
}

fn temp_external_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("vibex-external-{name}-{}", Uuid::new_v4()))
}

fn long_running_script() -> &'static str {
    #[cfg(windows)]
    {
        "ping -n 6 127.0.0.1 > nul"
    }
    #[cfg(not(windows))]
    {
        "sleep 5"
    }
}

fn env_probe_script() -> String {
    #[cfg(windows)]
    {
        format!(
            "echo PROJECT=%VK_PROJECT_NAME% & echo WORKSPACE=%VK_WORKSPACE_ID% & echo SESSION=%VK_SESSION_ID% & {}",
            long_running_script()
        )
    }
    #[cfg(not(windows))]
    {
        format!(
            "printf 'PROJECT=%s\\nWORKSPACE=%s\\nSESSION=%s\\n' \"$VK_PROJECT_NAME\" \"$VK_WORKSPACE_ID\" \"$VK_SESSION_ID\"; {}",
            long_running_script()
        )
    }
}

async fn wait_for_stdout(
    container: &LocalContainerService,
    process_id: Uuid,
    expected: &[String],
) -> String {
    for _ in 0..40 {
        if let Some(store) = container.msg_stores.read().await.get(&process_id).cloned() {
            let stdout = store
                .get_history()
                .into_iter()
                .filter_map(|msg| match msg {
                    utils::log_msg::LogMsg::Stdout(text) => Some(text),
                    _ => None,
                })
                .collect::<String>();
            if expected.iter().all(|value| stdout.contains(value)) {
                return stdout;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    container
        .msg_stores
        .read()
        .await
        .get(&process_id)
        .map(|store| {
            store
                .get_history()
                .into_iter()
                .filter_map(|msg| match msg {
                    utils::log_msg::LogMsg::Stdout(text) => Some(text),
                    _ => None,
                })
                .collect::<String>()
        })
        .unwrap_or_default()
}

async fn execution_process_test_pool() -> SqlitePool {
    let pool = SqlitePool::connect(":memory:").await.unwrap();
    sqlx::query(
        r#"
        CREATE TABLE execution_processes (
            id BLOB PRIMARY KEY NOT NULL,
            session_id BLOB NOT NULL,
            run_reason TEXT NOT NULL,
            executor_action TEXT NOT NULL,
            status TEXT NOT NULL,
            exit_code INTEGER,
            dropped INTEGER NOT NULL DEFAULT 0,
            started_at TEXT NOT NULL,
            completed_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    pool
}

async fn workspace_path_test_pool() -> SqlitePool {
    let pool = SqlitePool::connect(":memory:").await.unwrap();
    for statement in [
        r#"
        CREATE TABLE workspaces (
            id BLOB PRIMARY KEY NOT NULL,
            project_id BLOB NOT NULL,
            task_id BLOB NOT NULL,
            parent_workspace_id BLOB,
            container_ref TEXT,
            branch TEXT NOT NULL,
            use_worktree INTEGER NOT NULL,
            agent_working_dir TEXT,
            setup_completed_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
            archived INTEGER NOT NULL DEFAULT 0,
            pinned INTEGER NOT NULL DEFAULT 0,
            name TEXT
        )
        "#,
        r#"
        CREATE TABLE repos (
            id BLOB PRIMARY KEY NOT NULL,
            path TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            display_name TEXT NOT NULL,
            setup_script TEXT,
            cleanup_script TEXT,
            archive_script TEXT,
            copy_files TEXT,
            parallel_setup_script INTEGER NOT NULL DEFAULT 0,
            dev_server_script TEXT,
            default_target_branch TEXT,
            default_working_dir TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
        )
        "#,
        r#"
        CREATE TABLE workspace_repos (
            id BLOB PRIMARY KEY NOT NULL,
            workspace_id BLOB NOT NULL,
            repo_id BLOB NOT NULL,
            target_branch TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
        )
        "#,
        r#"
        CREATE TABLE images (
            id BLOB PRIMARY KEY NOT NULL,
            file_path TEXT NOT NULL,
            original_name TEXT NOT NULL,
            mime_type TEXT,
            size_bytes INTEGER NOT NULL,
            hash TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
        )
        "#,
        r#"
        CREATE TABLE task_images (
            id BLOB PRIMARY KEY NOT NULL,
            task_id BLOB NOT NULL,
            image_id BLOB NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
        )
        "#,
    ] {
        sqlx::query(statement).execute(&pool).await.unwrap();
    }
    pool
}

async fn stop_execution_test_pool() -> SqlitePool {
    let pool = workspace_path_test_pool().await;
    for statement in [
        r#"
        CREATE TABLE projects (
            id BLOB PRIMARY KEY NOT NULL,
            name TEXT NOT NULL,
            root_path TEXT NOT NULL DEFAULT '',
            parent_project_id BLOB,
            hidden INTEGER NOT NULL DEFAULT 0,
            is_git INTEGER NOT NULL DEFAULT 0,
            default_agent_working_dir TEXT,
            default_main_branch TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
        )
        "#,
        r#"
        CREATE TABLE tasks (
            id BLOB PRIMARY KEY NOT NULL,
            project_id BLOB NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            status TEXT NOT NULL DEFAULT 'todo',
            parent_workspace_id BLOB,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
        )
        "#,
        r#"
        CREATE TABLE sessions (
            id BLOB PRIMARY KEY NOT NULL,
            workspace_id BLOB NOT NULL,
            task_id BLOB,
            name TEXT,
            initial_prompt TEXT,
            status TEXT NOT NULL DEFAULT 'todo',
            executor TEXT,
            external_session_id TEXT,
            agent_type TEXT,
            agent_id TEXT,
            title_locked INTEGER NOT NULL DEFAULT 0,
            pinned_at TEXT,
            deleted_at TEXT,
            message_count INTEGER NOT NULL DEFAULT 0,
            model TEXT,
            parent_session_id BLOB REFERENCES sessions(id),
            parent_tool_use_id TEXT,
            delegation_call_id TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
        )
        "#,
        r#"
        CREATE TABLE session_checkpoints (
            id BLOB PRIMARY KEY NOT NULL,
            session_id BLOB NOT NULL,
            ordinal INTEGER NOT NULL,
            repo_id BLOB NOT NULL,
            before_head_commit TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
        )
        "#,
        r#"
        CREATE TABLE execution_processes (
            id BLOB PRIMARY KEY NOT NULL,
            session_id BLOB NOT NULL,
            run_reason TEXT NOT NULL,
            executor_action TEXT NOT NULL,
            status TEXT NOT NULL,
            exit_code INTEGER,
            dropped INTEGER NOT NULL DEFAULT 0,
            started_at TEXT NOT NULL,
            completed_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        "#,
        r#"
        CREATE TABLE execution_process_repo_states (
            id BLOB PRIMARY KEY NOT NULL,
            execution_process_id BLOB NOT NULL,
            repo_id BLOB NOT NULL,
            before_head_commit TEXT,
            after_head_commit TEXT,
            merge_commit TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
        )
        "#,
        r#"
        CREATE TABLE project_repos (
            id BLOB PRIMARY KEY NOT NULL,
            project_id BLOB NOT NULL,
            repo_id BLOB NOT NULL,
            setup_script TEXT,
            cleanup_script TEXT,
            copy_files TEXT,
            parallel_setup_script INTEGER NOT NULL DEFAULT 0
        )
        "#,
        r#"
        CREATE TABLE coding_agent_turns (
            id BLOB PRIMARY KEY NOT NULL,
            execution_process_id BLOB NOT NULL,
            agent_session_id TEXT,
            agent_message_id TEXT,
            prompt TEXT,
            summary TEXT,
            seen INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
        )
        "#,
        r#"
        CREATE TABLE execution_process_logs (
            execution_id BLOB NOT NULL,
            logs TEXT NOT NULL,
            byte_size INTEGER NOT NULL,
            inserted_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
        )
        "#,
    ] {
        sqlx::query(statement).execute(&pool).await.unwrap();
    }
    pool
}

fn test_container(pool: SqlitePool) -> LocalContainerService {
    let msg_stores = Arc::new(RwLock::new(HashMap::<Uuid, Arc<MsgStore>>::new()));
    let config = Arc::new(RwLock::new(Config::default()));
    LocalContainerService {
        db: DBService { pool: pool.clone() },
        child_store: Arc::new(RwLock::new(HashMap::new())),
        cancellation_tokens: Arc::new(RwLock::new(HashMap::new())),
        msg_stores: msg_stores.clone(),
        db_stream_handles: Arc::new(RwLock::new(HashMap::new())),
        exit_monitor_handles: Arc::new(RwLock::new(HashMap::new())),
        config: config.clone(),
        git: GitService::new(),
        image_service: ImageService::new(pool).unwrap(),
        notification_service: NotificationService::new(config),
        pty: crate::pty::PtyService::new(),
        settings_path: std::env::temp_dir()
            .join(format!("vibex-test-settings-{}.json", Uuid::new_v4())),
    }
}

async fn insert_workspace_with_repo(pool: &SqlitePool, workspace: &Workspace, repo: &Repo) {
    sqlx::query(
        r#"
        INSERT INTO workspaces (
            id, project_id, task_id, parent_workspace_id, container_ref,
            branch, use_worktree, agent_working_dir, setup_completed_at,
            archived, pinned, name
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(workspace.id)
    .bind(workspace.project_id)
    .bind(workspace.task_id)
    .bind(workspace.parent_workspace_id)
    .bind(&workspace.container_ref)
    .bind(&workspace.branch)
    .bind(workspace.use_worktree)
    .bind(&workspace.agent_working_dir)
    .bind(workspace.setup_completed_at)
    .bind(workspace.archived)
    .bind(workspace.pinned)
    .bind(&workspace.name)
    .execute(pool)
    .await
    .unwrap();

    insert_repo_for_workspace(pool, workspace, repo).await;
}

async fn insert_repo_for_workspace(pool: &SqlitePool, workspace: &Workspace, repo: &Repo) {
    sqlx::query(
        r#"
        INSERT INTO repos (
            id, path, name, display_name, setup_script, cleanup_script,
            archive_script, copy_files, parallel_setup_script, dev_server_script,
            default_target_branch, default_working_dir
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(repo.id)
    .bind(repo.path.to_string_lossy().to_string())
    .bind(&repo.name)
    .bind(&repo.display_name)
    .bind(&repo.setup_script)
    .bind(&repo.cleanup_script)
    .bind(&repo.archive_script)
    .bind(&repo.copy_files)
    .bind(repo.parallel_setup_script)
    .bind(&repo.dev_server_script)
    .bind(&repo.default_target_branch)
    .bind(&repo.default_working_dir)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        r#"
        INSERT INTO workspace_repos (id, workspace_id, repo_id, target_branch)
        VALUES (?, ?, ?, ?)
        "#,
    )
    .bind(Uuid::new_v4())
    .bind(workspace.id)
    .bind(repo.id)
    .bind("main")
    .execute(pool)
    .await
    .unwrap();
}

async fn insert_stop_project_and_task(pool: &SqlitePool, workspace: &Workspace) {
    sqlx::query(
        r#"
        INSERT INTO projects (id, name)
        VALUES (?, 'Project')
        "#,
    )
    .bind(workspace.project_id)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        r#"
        INSERT INTO tasks (id, project_id, title, description, status)
        VALUES (?, ?, 'Task', 'Description', 'inprogress')
        "#,
    )
    .bind(workspace.task_id)
    .bind(workspace.project_id)
    .execute(pool)
    .await
    .unwrap();
}

async fn insert_stop_session_execution(
    pool: &SqlitePool,
    workspace: &Workspace,
    session_id: Uuid,
    execution_process_id: Uuid,
    run_reason: &str,
    status: &str,
) {
    sqlx::query(
        r#"
        INSERT INTO sessions (id, workspace_id, task_id, status)
        VALUES (?, ?, ?, 'inprogress')
        "#,
    )
    .bind(session_id)
    .bind(workspace.id)
    .bind(workspace.task_id)
    .execute(pool)
    .await
    .unwrap();

    sqlx::query(
        r#"
        INSERT INTO execution_processes (
            id, session_id, run_reason, executor_action, status,
            exit_code, dropped, started_at, completed_at, created_at, updated_at
        ) VALUES (?, ?, ?, '{}', ?, NULL, 0,
            '2026-05-20T00:00:00Z', NULL,
            '2026-05-20T00:00:00Z', '2026-05-20T00:00:00Z'
        )
        "#,
    )
    .bind(execution_process_id)
    .bind(session_id)
    .bind(run_reason)
    .bind(status)
    .execute(pool)
    .await
    .unwrap();
}

async fn insert_execution_process_with_created_at(
    pool: &SqlitePool,
    session_id: Uuid,
    execution_process_id: Uuid,
    run_reason: &str,
    status: &str,
    created_at: &str,
) {
    sqlx::query(
        r#"
        INSERT INTO execution_processes (
            id, session_id, run_reason, executor_action, status,
            exit_code, dropped, started_at, completed_at, created_at, updated_at
        ) VALUES (?, ?, ?, '{}', ?, NULL, 0,
            ?, NULL, ?, ?
        )
        "#,
    )
    .bind(execution_process_id)
    .bind(session_id)
    .bind(run_reason)
    .bind(status)
    .bind(created_at)
    .bind(created_at)
    .bind(created_at)
    .execute(pool)
    .await
    .unwrap();
}

async fn insert_stop_execution_context(
    pool: &SqlitePool,
    workspace: &Workspace,
    session_id: Uuid,
    execution_process_id: Uuid,
    run_reason: &str,
) {
    insert_stop_project_and_task(pool, workspace).await;
    insert_stop_session_execution(
        pool,
        workspace,
        session_id,
        execution_process_id,
        run_reason,
        "running",
    )
    .await;
}

#[tokio::test]
async fn new_marks_orphaned_running_executions_failed() {
    let pool = execution_process_test_pool().await;
    let process_id = Uuid::new_v4();
    let session_id = Uuid::new_v4();

    sqlx::query(
        r#"
        INSERT INTO execution_processes (
            id, session_id, run_reason, executor_action, status,
            exit_code, dropped, started_at, completed_at, created_at, updated_at
        ) VALUES (?, ?, 'setupscript', '{}', 'running', NULL, 0,
            '2026-05-20T00:00:00Z', NULL,
            '2026-05-20T00:00:00Z', '2026-05-20T00:00:00Z'
        )
        "#,
    )
    .bind(process_id)
    .bind(session_id)
    .execute(&pool)
    .await
    .unwrap();

    let settings_dir = TempDir::new().unwrap();
    let msg_stores = Arc::new(RwLock::new(HashMap::<Uuid, Arc<MsgStore>>::new()));
    let _container = LocalContainerService::new(
        DBService { pool: pool.clone() },
        msg_stores.clone(),
        Arc::new(RwLock::new(Config::default())),
        GitService::new(),
        ImageService::new(pool.clone()).unwrap(),
        settings_dir.path().join("settings.json"),
        crate::pty::PtyService::new(),
    )
    .await;

    let (status, completed_at): (String, Option<String>) =
        sqlx::query_as("SELECT status, completed_at FROM execution_processes WHERE id = ?")
            .bind(process_id)
            .fetch_one(&pool)
            .await
            .unwrap();

    assert_eq!(status, "failed");
    assert!(completed_at.is_some());
}

#[tokio::test]
async fn cleanup_orphan_executions_records_after_head_commit() {
    let pool = stop_execution_test_pool().await;
    let temp_root = TempDir::new().unwrap();
    let mut repo_path = temp_root.path().join("repo");
    let git = GitService::new();
    seed_committed_repo(&git, &repo_path);
    if let Ok(canonical) = std::fs::canonicalize(&repo_path) {
        repo_path = canonical;
    }
    let expected_head = git.get_head_info(&repo_path).unwrap().oid;
    let workspace = sample_workspace(Some(&repo_path.to_string_lossy()), false, None);
    let repo = sample_repo("repo", &repo_path.to_string_lossy());
    let session_id = Uuid::new_v4();
    let process_id = Uuid::new_v4();
    insert_workspace_with_repo(&pool, &workspace, &repo).await;
    insert_stop_execution_context(&pool, &workspace, session_id, process_id, "setupscript").await;
    ExecutionProcessRepoState::create_many(
        &pool,
        process_id,
        &[CreateExecutionProcessRepoState {
            repo_id: repo.id,
            before_head_commit: None,
            after_head_commit: None,
            merge_commit: None,
        }],
    )
    .await
    .unwrap();
    let container = test_container(pool.clone());

    container.cleanup_orphan_executions().await.unwrap();

    let process = ExecutionProcess::find_by_id(&pool, process_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(process.status, ExecutionProcessStatus::Failed);
    let repo_states = ExecutionProcessRepoState::find_by_execution_process_id(&pool, process_id)
        .await
        .unwrap();
    assert_eq!(repo_states.len(), 1);
    if let Some(recorded) = repo_states[0].after_head_commit.as_deref() {
        assert_eq!(recorded, expected_head);
    }
}

#[tokio::test]
async fn stop_execution_without_child_cleans_logs_and_marks_task_in_review() {
    let pool = stop_execution_test_pool().await;
    let temp_root = TempDir::new().unwrap();
    let workspace = sample_workspace(
        Some(&temp_root.path().to_string_lossy()),
        true,
        Some("frontend"),
    );
    let repo = sample_repo("repo", &temp_root.path().join("repo").to_string_lossy());
    let session_id = Uuid::new_v4();
    let process_id = Uuid::new_v4();
    insert_workspace_with_repo(&pool, &workspace, &repo).await;
    insert_stop_execution_context(&pool, &workspace, session_id, process_id, "setupscript").await;
    let container = test_container(pool.clone());
    let store = Arc::new(MsgStore::new());
    store.push_stdout("running");
    container
        .msg_stores
        .write()
        .await
        .insert(process_id, store.clone());
    let (stream_done_tx, stream_done_rx) = tokio::sync::oneshot::channel();
    container.db_stream_handles.write().await.insert(
        process_id,
        tokio::spawn(async move {
            let _ = stream_done_tx.send(());
        }),
    );
    let process = ExecutionProcess::find_by_id(&pool, process_id)
        .await
        .unwrap()
        .unwrap();

    container
        .stop_execution(&process, ExecutionProcessStatus::Killed)
        .await
        .unwrap();

    stream_done_rx.await.unwrap();
    let process = ExecutionProcess::find_by_id(&pool, process_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(process.status, ExecutionProcessStatus::Killed);
    assert!(process.completed_at.is_some());
    assert!(container.msg_stores.read().await.get(&process_id).is_none());
    assert!(
        container
            .db_stream_handles
            .read()
            .await
            .get(&process_id)
            .is_none()
    );
    assert!(matches!(
        store.get_history().last(),
        Some(utils::log_msg::LogMsg::Finished)
    ));
    let task_status: String = sqlx::query_scalar("SELECT status FROM tasks WHERE id = ?")
        .bind(workspace.task_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(task_status, "inreview");
}

#[tokio::test]
async fn stop_execution_without_child_leaves_dev_server_task_status_unchanged() {
    let pool = stop_execution_test_pool().await;
    let temp_root = TempDir::new().unwrap();
    let workspace = sample_workspace(
        Some(&temp_root.path().to_string_lossy()),
        true,
        Some("frontend"),
    );
    let repo = sample_repo("repo", &temp_root.path().join("repo").to_string_lossy());
    let session_id = Uuid::new_v4();
    let process_id = Uuid::new_v4();
    insert_workspace_with_repo(&pool, &workspace, &repo).await;
    insert_stop_execution_context(&pool, &workspace, session_id, process_id, "devserver").await;
    let container = test_container(pool.clone());
    let store = Arc::new(MsgStore::new());
    store.push_stdout("running");
    container
        .msg_stores
        .write()
        .await
        .insert(process_id, store.clone());
    let process = ExecutionProcess::find_by_id(&pool, process_id)
        .await
        .unwrap()
        .unwrap();

    container
        .stop_execution(&process, ExecutionProcessStatus::Killed)
        .await
        .unwrap();

    let process = ExecutionProcess::find_by_id(&pool, process_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(process.status, ExecutionProcessStatus::Killed);
    assert!(container.msg_stores.read().await.get(&process_id).is_none());
    assert!(matches!(
        store.get_history().last(),
        Some(utils::log_msg::LogMsg::Finished)
    ));
    let task_status: String = sqlx::query_scalar("SELECT status FROM tasks WHERE id = ?")
        .bind(workspace.task_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(task_status, "inprogress");
}

#[tokio::test]
async fn stop_execution_without_child_records_after_head_commit() {
    let pool = stop_execution_test_pool().await;
    let temp_root = TempDir::new().unwrap();
    let repo_path = temp_root.path().join("repo");
    let git = GitService::new();
    seed_committed_repo(&git, &repo_path);
    let expected_head = git.get_head_info(&repo_path).unwrap().oid;
    let workspace = sample_workspace(Some(&repo_path.to_string_lossy()), false, None);
    let repo = sample_repo("repo", &repo_path.to_string_lossy());
    let session_id = Uuid::new_v4();
    let process_id = Uuid::new_v4();
    insert_workspace_with_repo(&pool, &workspace, &repo).await;
    insert_stop_execution_context(&pool, &workspace, session_id, process_id, "setupscript").await;
    ExecutionProcessRepoState::create_many(
        &pool,
        process_id,
        &[CreateExecutionProcessRepoState {
            repo_id: repo.id,
            before_head_commit: None,
            after_head_commit: None,
            merge_commit: None,
        }],
    )
    .await
    .unwrap();
    let container = test_container(pool.clone());
    let process = ExecutionProcess::find_by_id(&pool, process_id)
        .await
        .unwrap()
        .unwrap();

    container
        .stop_execution(&process, ExecutionProcessStatus::Killed)
        .await
        .unwrap();

    let repo_states = ExecutionProcessRepoState::find_by_execution_process_id(&pool, process_id)
        .await
        .unwrap();
    assert_eq!(repo_states.len(), 1);
    assert_eq!(repo_states[0].after_head_commit, Some(expected_head));
}

#[tokio::test]
async fn start_execution_script_stores_db_stream_handle_on_success() {
    let pool = stop_execution_test_pool().await;
    let temp_root = TempDir::new().unwrap();
    let workspace = sample_workspace(
        Some(&temp_root.path().to_string_lossy()),
        true,
        Some("frontend"),
    );
    let repo = sample_repo("repo", &temp_root.path().join("repo").to_string_lossy());
    let session_id = Uuid::new_v4();
    insert_workspace_with_repo(&pool, &workspace, &repo).await;
    insert_stop_project_and_task(&pool, &workspace).await;
    sqlx::query(
        r#"
        INSERT INTO sessions (id, workspace_id, task_id, status)
        VALUES (?, ?, ?, 'todo')
        "#,
    )
    .bind(session_id)
    .bind(workspace.id)
    .bind(workspace.task_id)
    .execute(&pool)
    .await
    .unwrap();

    let container = test_container(pool.clone());
    let action = ExecutorAction::new(
        ExecutorActionType::ScriptRequest(ScriptRequest {
            script: env_probe_script(),
            language: ScriptRequestLanguage::Bash,
            context: ScriptContext::SetupScript,
            working_dir: None,
        }),
        None,
    );
    let session = db::models::session::Session::find_by_id(&pool, session_id)
        .await
        .unwrap()
        .unwrap();

    let process = container
        .start_execution(
            &workspace,
            &session,
            &action,
            &db::models::execution_process::ExecutionProcessRunReason::SetupScript,
        )
        .await
        .unwrap();

    assert!(container.msg_stores.read().await.contains_key(&process.id));
    assert!(container.child_store.read().await.contains_key(&process.id));
    assert!(
        container
            .db_stream_handles
            .read()
            .await
            .contains_key(&process.id)
    );
    assert!(
        container
            .exit_monitor_handles
            .read()
            .await
            .contains_key(&process.id)
    );

    let stdout = wait_for_stdout(
        &container,
        process.id,
        &[
            "PROJECT=Project".to_string(),
            format!("WORKSPACE={}", workspace.id),
            format!("SESSION={}", session_id),
        ],
    )
    .await;
    assert!(stdout.contains("PROJECT=Project"), "{stdout}");
    assert!(
        stdout.contains(&format!("WORKSPACE={}", workspace.id)),
        "{stdout}"
    );
    assert!(
        stdout.contains(&format!("SESSION={session_id}")),
        "{stdout}"
    );

    container
        .stop_execution(&process, ExecutionProcessStatus::Killed)
        .await
        .unwrap();
}

#[tokio::test]
async fn try_stop_without_dev_server_stops_only_running_non_dev_processes() {
    let pool = stop_execution_test_pool().await;
    let temp_root = TempDir::new().unwrap();
    let workspace = sample_workspace(
        Some(&temp_root.path().to_string_lossy()),
        true,
        Some("frontend"),
    );
    let repo = sample_repo("repo", &temp_root.path().join("repo").to_string_lossy());
    let coding_session_id = Uuid::new_v4();
    let dev_session_id = Uuid::new_v4();
    let completed_session_id = Uuid::new_v4();
    let coding_process_id = Uuid::new_v4();
    let dev_process_id = Uuid::new_v4();
    let completed_process_id = Uuid::new_v4();
    insert_workspace_with_repo(&pool, &workspace, &repo).await;
    insert_stop_execution_context(
        &pool,
        &workspace,
        coding_session_id,
        coding_process_id,
        "setupscript",
    )
    .await;
    insert_stop_session_execution(
        &pool,
        &workspace,
        dev_session_id,
        dev_process_id,
        "devserver",
        "running",
    )
    .await;
    insert_stop_session_execution(
        &pool,
        &workspace,
        completed_session_id,
        completed_process_id,
        "setupscript",
        "completed",
    )
    .await;
    let container = test_container(pool.clone());

    container.try_stop(&workspace, false).await;

    let coding_process = ExecutionProcess::find_by_id(&pool, coding_process_id)
        .await
        .unwrap()
        .unwrap();
    let dev_process = ExecutionProcess::find_by_id(&pool, dev_process_id)
        .await
        .unwrap()
        .unwrap();
    let completed_process = ExecutionProcess::find_by_id(&pool, completed_process_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(coding_process.status, ExecutionProcessStatus::Killed);
    assert_eq!(dev_process.status, ExecutionProcessStatus::Running);
    assert_eq!(completed_process.status, ExecutionProcessStatus::Completed);
}

#[tokio::test]
async fn reset_session_to_process_stops_workspace_and_drops_target_tail() {
    let pool = stop_execution_test_pool().await;
    let temp_root = TempDir::new().unwrap();
    let repo_path = temp_root.path().join("repo");
    fs::create_dir_all(&repo_path).unwrap();
    let workspace = sample_workspace(Some(&repo_path.to_string_lossy()), false, None);
    let repo = sample_repo("repo", &repo_path.to_string_lossy());
    let target_session_id = Uuid::new_v4();
    let dev_session_id = Uuid::new_v4();
    let previous_process_id = Uuid::new_v4();
    let target_process_id = Uuid::new_v4();
    let running_process_id = Uuid::new_v4();
    let dev_process_id = Uuid::new_v4();
    insert_workspace_with_repo(&pool, &workspace, &repo).await;
    insert_stop_project_and_task(&pool, &workspace).await;
    sqlx::query(
        r#"
        INSERT INTO sessions (id, workspace_id, task_id, status)
        VALUES (?, ?, ?, 'inprogress'), (?, ?, ?, 'inprogress')
        "#,
    )
    .bind(target_session_id)
    .bind(workspace.id)
    .bind(workspace.task_id)
    .bind(dev_session_id)
    .bind(workspace.id)
    .bind(workspace.task_id)
    .execute(&pool)
    .await
    .unwrap();
    insert_execution_process_with_created_at(
        &pool,
        target_session_id,
        previous_process_id,
        "setupscript",
        "completed",
        "2026-05-20T00:00:00Z",
    )
    .await;
    insert_execution_process_with_created_at(
        &pool,
        target_session_id,
        target_process_id,
        "setupscript",
        "completed",
        "2026-05-20T00:01:00Z",
    )
    .await;
    insert_execution_process_with_created_at(
        &pool,
        target_session_id,
        running_process_id,
        "setupscript",
        "running",
        "2026-05-20T00:02:00Z",
    )
    .await;
    insert_execution_process_with_created_at(
        &pool,
        dev_session_id,
        dev_process_id,
        "devserver",
        "running",
        "2026-05-20T00:03:00Z",
    )
    .await;
    let container = test_container(pool.clone());

    container
        .reset_session_to_process(target_session_id, target_process_id, false, false)
        .await
        .unwrap();

    let previous: (String, bool) =
        sqlx::query_as("SELECT status, dropped FROM execution_processes WHERE id = ?")
            .bind(previous_process_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    let target: (String, bool) =
        sqlx::query_as("SELECT status, dropped FROM execution_processes WHERE id = ?")
            .bind(target_process_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    let running: (String, bool) =
        sqlx::query_as("SELECT status, dropped FROM execution_processes WHERE id = ?")
            .bind(running_process_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    let dev_server: (String, bool) =
        sqlx::query_as("SELECT status, dropped FROM execution_processes WHERE id = ?")
            .bind(dev_process_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(previous, ("completed".to_string(), false));
    assert_eq!(target, ("completed".to_string(), true));
    assert_eq!(running, ("killed".to_string(), true));
    assert_eq!(dev_server, ("running".to_string(), false));
}

#[tokio::test]
async fn finalize_task_marks_session_and_task_in_review() {
    let pool = stop_execution_test_pool().await;
    let temp_root = TempDir::new().unwrap();
    let workspace = sample_workspace(
        Some(&temp_root.path().to_string_lossy()),
        true,
        Some("frontend"),
    );
    let repo = sample_repo("repo", &temp_root.path().join("repo").to_string_lossy());
    let session_id = Uuid::new_v4();
    let process_id = Uuid::new_v4();
    insert_workspace_with_repo(&pool, &workspace, &repo).await;
    insert_stop_execution_context(&pool, &workspace, session_id, process_id, "setupscript").await;
    ExecutionProcess::update_completion(
        &pool,
        process_id,
        ExecutionProcessStatus::Completed,
        Some(0),
    )
    .await
    .unwrap();
    let container = test_container(pool.clone());
    let ctx = ExecutionProcess::load_context(&pool, process_id)
        .await
        .unwrap();

    container.finalize_task(&ctx).await;

    let session_status: String = sqlx::query_scalar("SELECT status FROM sessions WHERE id = ?")
        .bind(session_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    let task_status: String = sqlx::query_scalar("SELECT status FROM tasks WHERE id = ?")
        .bind(workspace.task_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(session_status, "inreview");
    assert_eq!(task_status, "inreview");
}

#[tokio::test]
async fn new_marks_orphaned_coding_agent_session_and_task_in_review() {
    let pool = stop_execution_test_pool().await;
    let temp_root = TempDir::new().unwrap();
    let workspace = sample_workspace(
        Some(&temp_root.path().to_string_lossy()),
        true,
        Some("frontend"),
    );
    let repo = sample_repo("repo", &temp_root.path().join("repo").to_string_lossy());
    let session_id = Uuid::new_v4();
    let process_id = Uuid::new_v4();
    insert_workspace_with_repo(&pool, &workspace, &repo).await;
    insert_stop_execution_context(&pool, &workspace, session_id, process_id, "setupscript").await;
    let msg_stores = Arc::new(RwLock::new(HashMap::<Uuid, Arc<MsgStore>>::new()));
    let _container = LocalContainerService::new(
        DBService { pool: pool.clone() },
        msg_stores.clone(),
        Arc::new(RwLock::new(Config::default())),
        GitService::new(),
        ImageService::new(pool.clone()).unwrap(),
        temp_root.path().join("settings.json"),
        crate::pty::PtyService::new(),
    )
    .await;

    let session_status: String = sqlx::query_scalar("SELECT status FROM sessions WHERE id = ?")
        .bind(session_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    let task_status: String = sqlx::query_scalar("SELECT status FROM tasks WHERE id = ?")
        .bind(workspace.task_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(session_status, "inreview");
    assert_eq!(task_status, "inreview");
}

#[tokio::test]
async fn storage_repair_preserves_registered_nested_worktree() {
    let pool = workspace_path_test_pool().await;
    let temp_root = TempDir::new().unwrap();
    let repo_path = temp_root.path().join("repo");
    let git = GitService::new();
    seed_committed_repo(&git, &repo_path);

    let branch = "feature/nested-worktree";
    let worktree_path = repo_path.join(".worktrees").join("nested-worktree");
    git.add_worktree_from_ref(&repo_path, &worktree_path, branch, "main")
        .unwrap();

    let mut workspace = sample_workspace(
        Some(&worktree_path.to_string_lossy()),
        true,
        Some("frontend"),
    );
    workspace.branch = branch.to_string();
    let repo = sample_repo("repo", &repo_path.to_string_lossy());
    insert_workspace_with_repo(&pool, &workspace, &repo).await;
    let container = test_container(pool);

    container
        .repair_workspace_storage_mode(&mut workspace, &[repo])
        .await
        .unwrap();

    assert!(workspace.use_worktree);
    assert_eq!(
        workspace.container_ref.as_deref(),
        Some(worktree_path.to_string_lossy().as_ref())
    );
}

#[tokio::test]
async fn storage_repair_clears_unregistered_nested_path() {
    let pool = workspace_path_test_pool().await;
    let temp_root = TempDir::new().unwrap();
    let repo_path = temp_root.path().join("repo");
    let git = GitService::new();
    git.initialize_repo_with_main_branch(&repo_path).unwrap();

    let nested_path = repo_path.join(".worktrees").join("not-a-worktree");
    fs::create_dir_all(&nested_path).unwrap();
    let mut workspace =
        sample_workspace(Some(&nested_path.to_string_lossy()), true, Some("frontend"));
    let repo = sample_repo("repo", &repo_path.to_string_lossy());
    insert_workspace_with_repo(&pool, &workspace, &repo).await;
    let container = test_container(pool);

    container
        .repair_workspace_storage_mode(&mut workspace, &[repo])
        .await
        .unwrap();

    assert!(workspace.use_worktree);
    assert_eq!(workspace.container_ref, None);
}

#[tokio::test]
async fn ensure_container_exists_reuses_directory_root_without_repos() {
    let pool = workspace_path_test_pool().await;
    let folder = TempDir::new().unwrap();
    let workspace = sample_workspace(
        Some(&folder.path().to_string_lossy()),
        false,
        Some(&folder.path().to_string_lossy()),
    );
    sqlx::query(
        r#"
        INSERT INTO workspaces (
            id, project_id, task_id, parent_workspace_id, container_ref,
            branch, use_worktree, agent_working_dir, setup_completed_at,
            archived, pinned, name
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(workspace.id)
    .bind(workspace.project_id)
    .bind(workspace.task_id)
    .bind(workspace.parent_workspace_id)
    .bind(&workspace.container_ref)
    .bind(&workspace.branch)
    .bind(workspace.use_worktree)
    .bind(&workspace.agent_working_dir)
    .bind(workspace.setup_completed_at)
    .bind(workspace.archived)
    .bind(workspace.pinned)
    .bind(&workspace.name)
    .execute(&pool)
    .await
    .unwrap();
    let container = test_container(pool);

    let container_ref = container.ensure_container_exists(&workspace).await.unwrap();

    assert_eq!(container_ref, folder.path().to_string_lossy());
}

#[tokio::test]
async fn ensure_container_exists_reuses_configured_direct_external_worktree() {
    let pool = workspace_path_test_pool().await;
    let external_root = TempDir::new().unwrap();
    let source_root = TempDir::new().unwrap();
    let workspace = sample_workspace(
        Some(&external_root.path().to_string_lossy()),
        true,
        Some("frontend"),
    );
    let repo = sample_repo("repo", &source_root.path().join("repo").to_string_lossy());
    insert_workspace_with_repo(&pool, &workspace, &repo).await;
    let container = test_container(pool.clone());

    let container_ref = container.ensure_container_exists(&workspace).await.unwrap();

    assert_eq!(container_ref, external_root.path().to_string_lossy());
    assert!(!external_root.path().join("repo").exists());
    let stored_ref: String =
        sqlx::query_scalar("SELECT container_ref FROM workspaces WHERE id = ?")
            .bind(workspace.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(stored_ref, external_root.path().to_string_lossy());
}

#[tokio::test]
async fn ensure_container_exists_rejects_missing_direct_external_worktree() {
    let pool = workspace_path_test_pool().await;
    let temp_root = TempDir::new().unwrap();
    let missing_external_root = temp_root.path().join("missing-worktree");
    let workspace = sample_workspace(
        Some(&missing_external_root.to_string_lossy()),
        true,
        Some("frontend"),
    );
    let repo = sample_repo("repo", &temp_root.path().join("repo").to_string_lossy());
    insert_workspace_with_repo(&pool, &workspace, &repo).await;
    let container = test_container(pool);

    let error = container
        .ensure_container_exists(&workspace)
        .await
        .unwrap_err();

    assert!(
        error
            .to_string()
            .contains("External worktree path does not exist")
    );
}

#[tokio::test]
async fn ensure_container_exists_discovers_existing_direct_external_worktree() {
    let pool = workspace_path_test_pool().await;
    let temp_root = TempDir::new().unwrap();
    let repo_path = temp_root.path().join("repo");
    let git = GitService::new();
    seed_committed_repo(&git, &repo_path);

    let branch = "feature/discovered-worktree";
    let worktree_path = temp_root.path().join("direct-worktree");
    WorktreeManager::create_worktree(&repo_path, branch, &worktree_path, "main", true)
        .await
        .unwrap();

    let mut workspace = sample_workspace(None, true, Some("frontend"));
    workspace.branch = branch.to_string();
    let repo = sample_repo("repo", &repo_path.to_string_lossy());
    insert_workspace_with_repo(&pool, &workspace, &repo).await;
    let container = test_container(pool.clone());

    let container_ref = container.ensure_container_exists(&workspace).await.unwrap();

    let expected_path = LocalContainerService::canonicalize_for_safety(&worktree_path);
    assert_eq!(
        LocalContainerService::canonicalize_for_safety(PathBuf::from(&container_ref).as_path()),
        expected_path
    );
    let stored_ref: String =
        sqlx::query_scalar("SELECT container_ref FROM workspaces WHERE id = ?")
            .bind(workspace.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        LocalContainerService::canonicalize_for_safety(PathBuf::from(&stored_ref).as_path()),
        expected_path
    );
}

#[test]
fn normalized_workspace_base_dir_uses_repo_path_without_worktree() {
    let workspace = sample_workspace(Some("C:/ignored/container"), false, Some("frontend"));
    let repo = sample_repo("repo", "C:/source/repo");

    assert_eq!(
        LocalContainerService::normalized_workspace_base_dir(&workspace, &[repo]),
        PathBuf::from("C:/source/repo")
    );
}

#[test]
fn normalized_workspace_base_dir_keeps_worktree_container_ref() {
    let workspace = sample_workspace(Some("C:/worktrees/repo-feature"), true, Some("frontend"));
    let repo = sample_repo("repo", "C:/source/repo");

    assert_eq!(
        LocalContainerService::normalized_workspace_base_dir(&workspace, &[repo]),
        PathBuf::from("C:/worktrees/repo-feature")
    );
}

#[test]
fn direct_external_worktree_detects_single_repo_checkout_root() {
    let workspace = sample_workspace(None, true, Some("frontend"));
    let repo = sample_repo("repo", "C:/source/repo");
    let external_root = temp_external_path("direct");

    assert!(LocalContainerService::is_direct_external_worktree(
        &workspace,
        &external_root,
        &[repo]
    ));
}

#[test]
fn direct_external_worktree_excludes_app_owned_workspace_dirs() {
    let workspace = sample_workspace(None, true, Some("frontend"));
    let repo = sample_repo("repo", "C:/source/repo");
    let app_owned_root = WorkspaceManager::get_workspace_base_dir().join("workspace-123");

    assert!(!LocalContainerService::is_direct_external_worktree(
        &workspace,
        &app_owned_root,
        &[repo]
    ));
}

#[test]
fn direct_external_worktree_excludes_agent_dirs_targeting_repo_folder() {
    let workspace = sample_workspace(None, true, Some("repo/frontend"));
    let repo = sample_repo("repo", "C:/source/repo");
    let external_root = temp_external_path("repo-folder");

    assert!(!LocalContainerService::is_direct_external_worktree(
        &workspace,
        &external_root,
        &[repo]
    ));
}

#[test]
fn workspace_repo_path_preserves_git_checkout_root() {
    let workspace = sample_workspace(None, true, None);
    let repo_name = "repo";
    let checkout_root = temp_external_path("checkout");
    fs::create_dir_all(&checkout_root).unwrap();
    fs::write(
        checkout_root.join(".git"),
        "gitdir: ../repo.git/worktrees/checkout",
    )
    .unwrap();

    assert_eq!(
        LocalContainerService::workspace_repo_path(&workspace, &checkout_root, repo_name),
        checkout_root
    );
}

#[path = "lifecycle_tests.rs"]
mod lifecycle;
