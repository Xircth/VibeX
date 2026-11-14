use super::*;
#[tokio::test]
async fn initialization_runs_in_repo_subdirectory_even_when_parent_already_exists() {
    use services::services::worktree_settings::{ProjectWorktreeSettings, save_project_settings};
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("source");
    let git = GitService::new();
    seed_committed_repo(&git, &source);
    fs::create_dir_all(source.join("app")).unwrap();
    fs::write(source.join("app/input.txt"), "prepared").unwrap();
    git.commit(&source, "app").unwrap();
    let root = temp.path().join(".vibex-workspaces/test");
    fs::create_dir_all(&root).unwrap();
    let workspace = sample_workspace(root.to_str(), true, Some("repo/app"));
    let mut repo = sample_repo("repo", source.to_str().unwrap());
    repo.default_working_dir = Some("app".into());
    let pool = workspace_path_test_pool().await;
    insert_workspace_with_repo(&pool, &workspace, &repo).await;
    let container = test_container(pool.clone());
    save_project_settings(
        &container.settings_path,
        workspace.project_id,
        ProjectWorktreeSettings {
            create_command: Some("echo ready>>initialized.txt".into()),
            ..ProjectWorktreeSettings::default()
        },
    )
    .await
    .unwrap();
    let (a, b) = tokio::join!(
        container.ensure_container_exists(&workspace),
        container.ensure_container_exists(&workspace)
    );
    a.unwrap();
    b.unwrap();
    assert_eq!(
        fs::read_to_string(root.join("repo/app/initialized.txt"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    assert!(!root.join("initialized.txt").exists());
    assert!(
        Workspace::find_by_id(&pool, workspace.id)
            .await
            .unwrap()
            .unwrap()
            .setup_completed_at
            .is_some()
    );
    let _ = fs::remove_file(&container.settings_path);
}

#[tokio::test]
async fn failed_initialization_keeps_workspace_and_only_explicit_retry_runs_it_again() {
    use services::services::worktree_settings::{ProjectWorktreeSettings, save_project_settings};
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("source");
    seed_committed_repo(&GitService::new(), &source);
    let root = temp.path().join(".vibex-workspaces/test");
    let workspace = sample_workspace(root.to_str(), true, Some("repo"));
    let repo = sample_repo("repo", source.to_str().unwrap());
    let pool = workspace_path_test_pool().await;
    insert_workspace_with_repo(&pool, &workspace, &repo).await;
    let container = test_container(pool.clone());
    let settings = ProjectWorktreeSettings {
        create_command: Some("echo attempted>>attempts.txt && exit 7".into()),
        ..Default::default()
    };
    save_project_settings(&container.settings_path, workspace.project_id, settings)
        .await
        .unwrap();
    assert!(
        container
            .ensure_container_exists(&workspace)
            .await
            .unwrap_err()
            .to_string()
            .contains("7")
    );
    assert!(
        Workspace::find_by_id(&pool, workspace.id)
            .await
            .unwrap()
            .is_some()
    );
    assert!(root.join("repo/.git").is_file());
    assert!(container.ensure_container_exists(&workspace).await.is_err());
    assert_eq!(
        fs::read_to_string(root.join("repo/attempts.txt"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    save_project_settings(
        &container.settings_path,
        workspace.project_id,
        ProjectWorktreeSettings {
            create_command: Some("echo recovered>>attempts.txt".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    container.create(&workspace).await.unwrap();
    assert_eq!(
        fs::read_to_string(root.join("repo/attempts.txt"))
            .unwrap()
            .lines()
            .count(),
        2
    );
    let _ = fs::remove_file(&container.settings_path);
}

#[tokio::test]
async fn source_changes_are_available_to_initialization() {
    use services::services::worktree_settings::{ProjectWorktreeSettings, save_project_settings};
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("source");
    seed_committed_repo(&GitService::new(), &source);
    fs::write(source.join("README.md"), "changed\n").unwrap();
    fs::write(source.join("new.txt"), "untracked\n").unwrap();
    let root = temp.path().join(".vibex-workspaces/test");
    let workspace = sample_workspace(root.to_str(), true, Some("repo"));
    let repo = sample_repo("repo", source.to_str().unwrap());
    let pool = workspace_path_test_pool().await;
    insert_workspace_with_repo(&pool, &workspace, &repo).await;
    let container = test_container(pool);
    let command = if cfg!(windows) {
        "type README.md new.txt > observed.txt"
    } else {
        "cat README.md new.txt > observed.txt"
    };
    save_project_settings(
        &container.settings_path,
        workspace.project_id,
        ProjectWorktreeSettings {
            create_command: Some(command.into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    container.provision(&workspace, true).await.unwrap();
    assert_eq!(
        fs::read_to_string(root.join("repo/observed.txt"))
            .unwrap()
            .replace("\r\n", "\n"),
        "changed\nuntracked\n"
    );
    assert_eq!(
        fs::read_to_string(source.join("README.md")).unwrap(),
        "changed\n"
    );
    let _ = fs::remove_file(&container.settings_path);
}

#[tokio::test]
async fn delete_hook_failure_preserves_registered_path_and_files() {
    use services::services::worktree_settings::{ProjectWorktreeSettings, save_project_settings};
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("source");
    seed_committed_repo(&GitService::new(), &source);
    let root = temp.path().join(".vibex-workspaces/test");
    let workspace = sample_workspace(root.to_str(), true, Some("repo"));
    let repo = sample_repo("repo", source.to_str().unwrap());
    let pool = workspace_path_test_pool().await;
    insert_workspace_with_repo(&pool, &workspace, &repo).await;
    let container = test_container(pool.clone());
    container.ensure_container_exists(&workspace).await.unwrap();
    save_project_settings(
        &container.settings_path,
        workspace.project_id,
        ProjectWorktreeSettings {
            delete_command: Some("exit 9".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert!(
        LocalContainerService::cleanup_workspace(
            &container.db,
            &workspace,
            &container.settings_path
        )
        .await
        .is_err()
    );
    assert!(root.join("repo/README.md").exists());
    assert_eq!(
        PathBuf::from(
            Workspace::find_by_id(&pool, workspace.id)
                .await
                .unwrap()
                .unwrap()
                .container_ref
                .unwrap()
        ),
        root
    );
    let _ = fs::remove_file(&container.settings_path);
}

#[tokio::test]
async fn multi_repository_initialization_rebuilds_only_the_missing_repository() {
    use services::services::worktree_settings::{ProjectWorktreeSettings, save_project_settings};
    let temp = TempDir::new().unwrap();
    let root = temp.path().join(".vibex-workspaces/test");
    let workspace = sample_workspace(root.to_str(), true, None);
    let source_a = temp.path().join("source-a");
    let source_b = temp.path().join("source-b");
    seed_committed_repo(&GitService::new(), &source_a);
    seed_committed_repo(&GitService::new(), &source_b);
    let repo_a = sample_repo("a", source_a.to_str().unwrap());
    let repo_b = sample_repo("b", source_b.to_str().unwrap());
    let pool = workspace_path_test_pool().await;
    insert_workspace_with_repo(&pool, &workspace, &repo_a).await;
    insert_repo_for_workspace(&pool, &workspace, &repo_b).await;
    let container = test_container(pool);
    save_project_settings(
        &container.settings_path,
        workspace.project_id,
        ProjectWorktreeSettings {
            create_command: Some("echo initialized>>setup.txt".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    container.ensure_container_exists(&workspace).await.unwrap();
    assert_eq!(
        fs::read_to_string(root.join("a/setup.txt"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    assert_eq!(
        fs::read_to_string(root.join("b/setup.txt"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    // A checkout with only Git metadata is repaired by the materializer.
    fs::remove_file(root.join("a/README.md")).unwrap();
    fs::remove_file(root.join("a/setup.txt")).unwrap();
    container.ensure_container_exists(&workspace).await.unwrap();
    assert!(root.join("a/README.md").is_file());
    assert!(root.join("a/setup.txt").is_file());
    assert_eq!(
        fs::read_to_string(root.join("b/setup.txt"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    let _ = fs::remove_file(&container.settings_path);
}

#[tokio::test]
async fn initialization_can_be_cancelled_and_retains_output_for_review() {
    use services::services::{
        workspace_lifecycle::{cancel_initialization, initialization_status},
        worktree_settings::{ProjectWorktreeSettings, save_project_settings},
    };
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("source");
    seed_committed_repo(&GitService::new(), &source);
    let root = temp.path().join(".vibex-workspaces/test");
    let workspace = sample_workspace(root.to_str(), true, Some("repo"));
    let repo = sample_repo("repo", source.to_str().unwrap());
    let pool = workspace_path_test_pool().await;
    insert_workspace_with_repo(&pool, &workspace, &repo).await;
    let container = test_container(pool);
    let command = if cfg!(windows) {
        "echo started > started.txt & ping -n 30 127.0.0.1 > nul"
    } else {
        "echo started > started.txt; sleep 30"
    };
    save_project_settings(
        &container.settings_path,
        workspace.project_id,
        ProjectWorktreeSettings {
            create_command: Some(command.into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let initialize = container.ensure_container_exists(&workspace);
    let cancel = async {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            while !root.join("repo/started.txt").exists() {
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        assert!(cancel_initialization(workspace.id));
    };
    let (result, ()) = tokio::join!(initialize, cancel);
    assert!(result.unwrap_err().to_string().contains("cancelled"));
    assert_eq!(
        initialization_status(&workspace).await.unwrap().phase,
        "failed"
    );
    assert!(root.join("repo/started.txt").exists());
    let _ = fs::remove_file(&container.settings_path);
}
