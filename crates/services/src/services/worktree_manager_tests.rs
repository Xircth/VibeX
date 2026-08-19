use super::*;
#[cfg(test)]
mod safety_tests {
    use tempfile::TempDir;

    use super::*;

    #[tokio::test]
    async fn ensure_worktree_refuses_to_target_source_repo() {
        let td = TempDir::new().unwrap();
        let repo_path = td.path().join("repo");
        GitService::new()
            .initialize_repo_with_main_branch(&repo_path)
            .unwrap();

        let error = WorktreeManager::ensure_worktree_exists(&repo_path, "main", &repo_path)
            .await
            .unwrap_err();

        assert!(matches!(error, WorktreeError::InvalidPath(_)));
        assert!(repo_path.exists());
    }

    #[tokio::test]
    async fn ensure_worktree_refuses_target_inside_source_repo() {
        let td = TempDir::new().unwrap();
        let repo_path = td.path().join("repo");
        GitService::new()
            .initialize_repo_with_main_branch(&repo_path)
            .unwrap();
        let nested_target = repo_path.join("child-worktree");

        let error = WorktreeManager::ensure_worktree_exists(&repo_path, "main", &nested_target)
            .await
            .unwrap_err();

        assert!(matches!(error, WorktreeError::InvalidPath(_)));
        assert!(repo_path.exists());
        assert!(!nested_target.exists());
    }
}

#[tokio::test]
async fn create_worktree_when_repo_path_is_a_worktree() {
    use tempfile::TempDir;
    let td = TempDir::new().unwrap();

    let repo_path = td.path().join("repo");
    let git_service = GitService::new();
    git_service
        .initialize_repo_with_main_branch(&repo_path)
        .unwrap();

    let base_worktree_path = td.path().join("wt-base");
    WorktreeManager::create_worktree(
        &repo_path,
        "wt-base-branch",
        &base_worktree_path,
        "main",
        true,
    )
    .await
    .unwrap();
    assert!(base_worktree_path.join(".git").is_file());

    let child_worktree_path = td.path().join("wt-child");
    WorktreeManager::create_worktree(
        &base_worktree_path,
        "wt-child-branch",
        &child_worktree_path,
        "main",
        true,
    )
    .await
    .unwrap();
    assert!(child_worktree_path.join(".git").is_file());

    // Regression: repo_path itself is a worktree (so `.git` is a file), but metadata lookup still works.
    WorktreeManager::ensure_worktree_exists(
        &base_worktree_path,
        "wt-child-branch",
        &child_worktree_path,
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn create_worktree_creates_local_branch_when_only_remote_tracking_ref_exists() {
    use tempfile::TempDir;

    let td = TempDir::new().unwrap();
    let repo_path = td.path().join("repo");
    let git_service = GitService::new();
    git_service
        .initialize_repo_with_main_branch(&repo_path)
        .unwrap();
    std::fs::write(repo_path.join("README.md"), "hello\n").unwrap();
    git_service.commit(&repo_path, "seed").unwrap();

    let repo = Repository::open(&repo_path).unwrap();
    let head = repo.head().unwrap().target().unwrap();
    repo.reference("refs/remotes/origin/vu/3e19", head, true, "test remote ref")
        .unwrap();

    assert!(!WorktreeManager::local_branch_exists(&repo_path, "vu/3e19"));

    let worktree_path = td.path().join("wt-new");
    WorktreeManager::create_worktree(&repo_path, "vu/3e19", &worktree_path, "main", true)
        .await
        .unwrap();

    assert!(worktree_path.join(".git").is_file());
    assert!(WorktreeManager::local_branch_exists(&repo_path, "vu/3e19"));
}

#[tokio::test]
async fn create_worktree_from_local_main_materializes_directories() {
    use tempfile::TempDir;

    let td = TempDir::new().unwrap();
    let repo_path = td.path().join("repo");
    let git_service = GitService::new();
    git_service
        .initialize_repo_with_main_branch(&repo_path)
        .unwrap();

    std::fs::create_dir_all(repo_path.join("src").join("nested")).unwrap();
    std::fs::write(repo_path.join("README.md"), "root\n").unwrap();
    std::fs::write(
        repo_path.join("src").join("nested").join("app.txt"),
        "main\n",
    )
    .unwrap();
    git_service
        .commit(&repo_path, "seed main contents")
        .unwrap();

    let worktree_path = td.path().join("wt-from-main");
    WorktreeManager::create_worktree(&repo_path, "vu/from-main", &worktree_path, "main", true)
        .await
        .unwrap();

    assert!(worktree_path.join(".git").is_file());
    assert_eq!(
        std::fs::read_to_string(worktree_path.join("README.md"))
            .unwrap()
            .trim_end(),
        "root"
    );
    assert_eq!(
        std::fs::read_to_string(worktree_path.join("src").join("nested").join("app.txt"))
            .unwrap()
            .trim_end(),
        "main"
    );
}

#[tokio::test]
async fn create_worktree_from_empty_main_seeds_untracked_project_files() {
    use tempfile::TempDir;

    let td = TempDir::new().unwrap();
    let repo_path = td.path().join("repo");
    let git_service = GitService::new();
    git_service
        .initialize_repo_with_main_branch(&repo_path)
        .unwrap();
    let git = GitCli::new();

    std::fs::create_dir_all(repo_path.join("backend").join("routes")).unwrap();
    std::fs::create_dir_all(repo_path.join("frontend-react").join("src")).unwrap();
    std::fs::write(
        repo_path
            .join("backend")
            .join("routes")
            .join("contracts.js"),
        "module.exports = {}\n",
    )
    .unwrap();
    std::fs::write(
        repo_path.join("frontend-react").join("src").join("App.jsx"),
        "export default function App() {}\n",
    )
    .unwrap();

    assert!(
        !git.git(&repo_path, ["status", "--short"])
            .unwrap()
            .is_empty()
    );
    assert!(
        git.git(&repo_path, ["ls-tree", "-r", "--name-only", "main"])
            .unwrap()
            .trim()
            .is_empty()
    );

    let worktree_path = td.path().join("wt-from-empty-main");
    WorktreeManager::create_worktree(
        &repo_path,
        "vu/from-empty-main",
        &worktree_path,
        "main",
        true,
    )
    .await
    .unwrap();

    assert!(worktree_path.join(".git").is_file());
    assert!(
        worktree_path
            .join("backend")
            .join("routes")
            .join("contracts.js")
            .is_file()
    );
    assert!(
        worktree_path
            .join("frontend-react")
            .join("src")
            .join("App.jsx")
            .is_file()
    );
}

#[tokio::test]
async fn create_worktree_uses_local_target_branch_even_when_upstream_moved() {
    use std::ffi::OsString;

    use tempfile::TempDir;

    let td = TempDir::new().unwrap();
    let source_path = td.path().join("source");
    let repo_path = td.path().join("repo");
    let worktree_path = td.path().join("wt-synced");
    let git_service = GitService::new();
    let git = GitCli::new();

    git_service
        .initialize_repo_with_main_branch(&source_path)
        .unwrap();
    std::fs::write(source_path.join("README.md"), "v1\n").unwrap();
    git_service.commit(&source_path, "seed").unwrap();

    git.git(
        td.path(),
        vec![OsString::from("init"), repo_path.as_os_str().into()],
    )
    .unwrap();
    git.git(
        &repo_path,
        vec![
            OsString::from("remote"),
            OsString::from("add"),
            OsString::from("origin"),
            source_path.as_os_str().into(),
        ],
    )
    .unwrap();
    git.git(&repo_path, ["fetch", "origin", "main"]).unwrap();
    git.git(&repo_path, ["checkout", "-b", "main", "origin/main"])
        .unwrap();
    git.git(
        &repo_path,
        ["branch", "--set-upstream-to=origin/main", "main"],
    )
    .unwrap();

    std::fs::write(source_path.join("README.md"), "v2\n").unwrap();
    git_service.commit(&source_path, "remote update").unwrap();

    assert_eq!(
        std::fs::read_to_string(repo_path.join("README.md"))
            .unwrap()
            .trim_end(),
        "v1"
    );

    WorktreeManager::create_worktree(&repo_path, "vu/synced", &worktree_path, "main", true)
        .await
        .unwrap();

    assert!(worktree_path.join(".git").is_file());
    assert_eq!(
        std::fs::read_to_string(worktree_path.join("README.md"))
            .unwrap()
            .trim_end(),
        "v1"
    );
}

#[tokio::test]
async fn ensure_worktree_exists_recreates_git_only_worktree() {
    use tempfile::TempDir;

    let td = TempDir::new().unwrap();
    let repo_path = td.path().join("repo");
    let git_service = GitService::new();
    git_service
        .initialize_repo_with_main_branch(&repo_path)
        .unwrap();
    std::fs::write(repo_path.join("README.md"), "hello\n").unwrap();
    git_service.commit(&repo_path, "seed").unwrap();

    let worktree_path = td.path().join("wt-feature");
    WorktreeManager::create_worktree(&repo_path, "wt-feature", &worktree_path, "main", true)
        .await
        .unwrap();
    assert!(worktree_path.join("README.md").exists());

    for entry in std::fs::read_dir(&worktree_path).unwrap() {
        let entry = entry.unwrap();
        if entry.file_name() != OsStr::new(".git") {
            let path = entry.path();
            if path.is_dir() {
                std::fs::remove_dir_all(path).unwrap();
            } else {
                std::fs::remove_file(path).unwrap();
            }
        }
    }

    assert!(worktree_path.join(".git").is_file());
    assert!(!worktree_path.join("README.md").exists());

    WorktreeManager::ensure_worktree_exists(&repo_path, "wt-feature", &worktree_path)
        .await
        .unwrap();

    assert!(worktree_path.join("README.md").exists());
}

#[tokio::test]
async fn repair_materialized_checkout_restores_files_from_local_head() {
    use tempfile::TempDir;

    let td = TempDir::new().unwrap();
    let repo_path = td.path().join("repo");
    let git_service = GitService::new();
    git_service
        .initialize_repo_with_main_branch(&repo_path)
        .unwrap();
    std::fs::write(repo_path.join("README.md"), "hello\n").unwrap();
    git_service.commit(&repo_path, "seed").unwrap();

    let worktree_path = td.path().join("wt-feature");
    WorktreeManager::create_worktree(&repo_path, "wt-feature", &worktree_path, "main", true)
        .await
        .unwrap();
    assert!(worktree_path.join("README.md").exists());

    for entry in std::fs::read_dir(&worktree_path).unwrap() {
        let entry = entry.unwrap();
        if entry.file_name() != OsStr::new(".git") {
            let path = entry.path();
            if path.is_dir() {
                std::fs::remove_dir_all(path).unwrap();
            } else {
                std::fs::remove_file(path).unwrap();
            }
        }
    }

    assert!(worktree_path.join(".git").is_file());
    assert!(!worktree_path.join("README.md").exists());

    assert!(WorktreeManager::repair_materialized_checkout(&worktree_path).unwrap());
    assert_eq!(
        std::fs::read_to_string(worktree_path.join("README.md"))
            .unwrap()
            .trim_end(),
        "hello"
    );
}

#[tokio::test]
async fn ensure_worktree_exists_recreates_git_only_worktree_with_invalid_head() {
    use tempfile::TempDir;

    let td = TempDir::new().unwrap();
    let repo_path = td.path().join("repo");
    let git_service = GitService::new();
    git_service
        .initialize_repo_with_main_branch(&repo_path)
        .unwrap();
    std::fs::write(repo_path.join("README.md"), "hello\n").unwrap();
    git_service.commit(&repo_path, "seed").unwrap();

    let worktree_path = td.path().join("wt-broken");
    WorktreeManager::create_worktree(&repo_path, "wt-broken", &worktree_path, "main", true)
        .await
        .unwrap();
    assert!(worktree_path.join("README.md").exists());

    for entry in std::fs::read_dir(&worktree_path).unwrap() {
        let entry = entry.unwrap();
        if entry.file_name() != OsStr::new(".git") {
            let path = entry.path();
            if path.is_dir() {
                std::fs::remove_dir_all(path).unwrap();
            } else {
                std::fs::remove_file(path).unwrap();
            }
        }
    }

    let gitdir_file = std::fs::read_to_string(worktree_path.join(".git")).unwrap();
    let gitdir_path = gitdir_file
        .trim()
        .strip_prefix("gitdir: ")
        .map(|value| worktree_path.join(value))
        .unwrap();
    std::fs::write(gitdir_path.join("HEAD"), "ref: refs/heads/does-not-exist\n").unwrap();

    WorktreeManager::ensure_worktree_exists(&repo_path, "wt-broken", &worktree_path)
        .await
        .unwrap();

    assert!(worktree_path.join("README.md").exists());
}

#[tokio::test]
async fn create_worktree_falls_back_to_head_branch_when_base_branch_is_missing() {
    use tempfile::TempDir;

    let td = TempDir::new().unwrap();
    let repo_path = td.path().join("repo");
    let git_service = GitService::new();
    // Initialize with the actual default branch named "master" so the
    // requested "main" base does not exist.
    std::fs::create_dir_all(&repo_path).unwrap();
    let repo = git2::Repository::init_opts(
        &repo_path,
        git2::RepositoryInitOptions::new().initial_head("master"),
    )
    .unwrap();
    git_service.create_initial_commit(&repo).unwrap();
    std::fs::write(repo_path.join("README.md"), "master seed\n").unwrap();
    git_service.commit(&repo_path, "seed").unwrap();

    let worktree_path = td.path().join("wt-fallback");
    WorktreeManager::create_worktree(&repo_path, "wt-fallback", &worktree_path, "main", true)
        .await
        .unwrap();

    assert!(worktree_path.join(".git").is_file());
    assert!(worktree_path.join("README.md").exists());
    assert!(WorktreeManager::local_branch_exists(
        &repo_path,
        "wt-fallback"
    ));
}
