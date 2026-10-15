use std::path::Path;

use db::models::{repo::Repo, workspace::Workspace, workspace_repo::WorkspaceRepo};
use git::GitService;
use sqlx::SqlitePool;
use uuid::Uuid;

use super::sanitize_file_path;
use crate::error::AppError;

/// Read a text blob from `revision` when set, otherwise from HEAD.
/// `revision` is the diff merge-base, the same commit the diff stream diffs against.
pub(super) fn read_text_file_at_revision(
    file_path: &str,
    revision: Option<&str>,
) -> Result<String, AppError> {
    let path = sanitize_file_path(file_path)?;

    let repo = git2::Repository::discover(&path)
        .map_err(|e| AppError::Internal(format!("Failed to open git repo: {}", e)))?;

    let workdir = repo.workdir().ok_or_else(|| {
        AppError::Internal("Bare repository has no working directory".to_string())
    })?;
    let workdir = workdir.canonicalize().map_err(|e| {
        AppError::Internal(format!(
            "Failed to resolve git workdir {}: {}",
            workdir.display(),
            e
        ))
    })?;

    let relative_path = path.strip_prefix(&workdir).map_err(|_| {
        AppError::BadRequest(format!(
            "File {} is not within the repository working directory",
            file_path
        ))
    })?;

    let commit = match revision {
        Some(revision) => {
            let oid = git2::Oid::from_str(revision).map_err(|error| {
                AppError::BadRequest(format!("Invalid commit {revision}: {error}"))
            })?;
            repo.find_commit(oid).map_err(|error| {
                AppError::NotFound(format!("Commit {revision} was not found: {error}"))
            })?
        }
        None => {
            let head = repo
                .head()
                .map_err(|e| AppError::Internal(format!("Failed to get HEAD: {}", e)))?;
            head.peel_to_commit()
                .map_err(|e| AppError::Internal(format!("Failed to peel HEAD to commit: {}", e)))?
        }
    };
    let label = revision.unwrap_or("HEAD");
    let tree = commit
        .tree()
        .map_err(|e| AppError::Internal(format!("Failed to get commit tree: {}", e)))?;

    let git_path = relative_path.to_string_lossy().replace('\\', "/");
    let tree_entry = tree
        .get_path(Path::new(&git_path))
        .map_err(|_| AppError::NotFound(format!("File not found in {label}: {}", git_path)))?;

    let blob = repo
        .find_blob(tree_entry.id())
        .map_err(|e| AppError::Internal(format!("Failed to read blob: {}", e)))?;

    if blob.is_binary() {
        return Err(AppError::BadRequest(format!(
            "Binary file cannot be opened as text: {}",
            git_path
        )));
    }

    std::str::from_utf8(blob.content())
        .map(|content| content.to_string())
        .map_err(|_| {
            AppError::BadRequest(format!(
                "Binary file cannot be opened as text: {}",
                git_path
            ))
        })
}

/// The merge-base the workspace diff stream uses for this repo.
pub(super) async fn workspace_diff_base_revision(
    pool: &SqlitePool,
    git: &GitService,
    workspace_id: Uuid,
    repo_id: Uuid,
) -> Result<String, AppError> {
    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {workspace_id} not found")))?;
    let repo = Repo::find_by_id(pool, repo_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Repo {repo_id} not found")))?;
    let links = WorkspaceRepo::find_by_workspace_id(pool, workspace_id).await?;
    let target_branch = links
        .into_iter()
        .find(|link| link.repo_id == repo_id)
        .map(|link| link.target_branch)
        .ok_or_else(|| {
            AppError::BadRequest(format!(
                "Workspace {workspace_id} has no target branch for repo {repo_id}"
            ))
        })?;
    let repo_path = repo.path.clone();
    let branch = workspace.branch.clone();
    let git = git.clone();
    tokio::task::spawn_blocking(move || {
        git.get_base_commit(&repo_path, &branch, &target_branch)
            .map(|commit| commit.to_string())
            .map_err(|error| AppError::Internal(error.to_string()))
    })
    .await
    .map_err(|error| AppError::Internal(error.to_string()))?
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::read_text_file_at_revision;
    use crate::error::AppError;

    fn create_temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("vibex-git-head-{prefix}-{unique}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn path_string(path: &Path) -> String {
        path.to_string_lossy().to_string()
    }

    fn commit_file(root: &Path, relative_path: &str, bytes: &[u8]) -> git2::Repository {
        let repo = git2::Repository::init(root).unwrap();
        let file_path = root.join(relative_path);
        fs::create_dir_all(file_path.parent().unwrap()).unwrap();
        fs::write(&file_path, bytes).unwrap();

        let mut index = repo.index().unwrap();
        index.add_path(Path::new(relative_path)).unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let signature = git2::Signature::now("VibeX Test", "test@example.com").unwrap();
        repo.commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
            .unwrap();
        drop(tree);
        repo
    }

    #[test]
    fn get_file_at_head_reads_committed_content_not_worktree() {
        let root = create_temp_dir("text");
        let repo = commit_file(&root, "src/main.txt", b"from head");
        fs::write(root.join("src/main.txt"), "worktree changed").unwrap();

        let content =
            read_text_file_at_revision(&path_string(&root.join("src/main.txt")), None).unwrap();
        drop(repo);
        let _ = fs::remove_dir_all(&root);

        assert_eq!(content, "from head");
    }

    #[test]
    fn read_text_file_at_revision_reads_the_requested_commit_not_head() {
        let root = create_temp_dir("base");
        let repo = commit_file(&root, "src/main.txt", b"base line\n");
        let first = repo.head().unwrap().peel_to_commit().unwrap().id();
        fs::write(root.join("src/main.txt"), "base line\nadded\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("src/main.txt")).unwrap();
        let tree_id = index.write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        let signature = git2::Signature::now("VibeX Test", "test@example.com").unwrap();
        let parent = repo.find_commit(first).unwrap();
        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            "second",
            &tree,
            &[&parent],
        )
        .unwrap();

        let path = path_string(&root.join("src/main.txt"));
        let at_base = read_text_file_at_revision(&path, Some(&first.to_string())).unwrap();
        let at_head = read_text_file_at_revision(&path, None).unwrap();
        drop(parent);
        drop(tree);
        drop(repo);
        let _ = fs::remove_dir_all(&root);

        assert_eq!(at_base, "base line\n");
        assert_eq!(at_head, "base line\nadded\n");
    }

    #[test]
    fn get_file_at_head_rejects_binary_blob() {
        let root = create_temp_dir("binary");
        let repo = commit_file(&root, "asset.bin", &[0, 1, 2, 3]);

        let error =
            read_text_file_at_revision(&path_string(&root.join("asset.bin")), None).unwrap_err();
        drop(repo);
        let _ = fs::remove_dir_all(&root);

        assert!(matches!(error, AppError::BadRequest(_)));
        assert!(
            error
                .to_string()
                .contains("Binary file cannot be opened as text")
        );
    }
}
