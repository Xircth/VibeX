use std::path::Path;

use super::sanitize_file_path;
use crate::error::AppError;

pub(super) fn get_file_at_head_content(file_path: &str) -> Result<String, AppError> {
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

    let head = repo
        .head()
        .map_err(|e| AppError::Internal(format!("Failed to get HEAD: {}", e)))?;
    let commit = head
        .peel_to_commit()
        .map_err(|e| AppError::Internal(format!("Failed to peel HEAD to commit: {}", e)))?;
    let tree = commit
        .tree()
        .map_err(|e| AppError::Internal(format!("Failed to get commit tree: {}", e)))?;

    let git_path = relative_path.to_string_lossy().replace('\\', "/");
    let tree_entry = tree
        .get_path(Path::new(&git_path))
        .map_err(|_| AppError::NotFound(format!("File not found in HEAD: {}", git_path)))?;

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

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::get_file_at_head_content;
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

        let content = get_file_at_head_content(&path_string(&root.join("src/main.txt"))).unwrap();
        drop(repo);
        let _ = fs::remove_dir_all(&root);

        assert_eq!(content, "from head");
    }

    #[test]
    fn get_file_at_head_rejects_binary_blob() {
        let root = create_temp_dir("binary");
        let repo = commit_file(&root, "asset.bin", &[0, 1, 2, 3]);

        let error = get_file_at_head_content(&path_string(&root.join("asset.bin"))).unwrap_err();
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
