use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::AppError;

#[derive(Debug, Serialize, Clone)]
pub struct FileTreeEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<FileTreeEntry>>,
    pub git_status: Option<String>,
}

/// Directories to skip when building the file tree.
const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    ".next",
    "dist",
    "build",
    "__pycache__",
    ".venv",
    "venv",
];

/// Build a map of file path -> git status string using git2.
fn build_git_status_map(root: &Path) -> HashMap<PathBuf, String> {
    let mut map = HashMap::new();

    let repo = match git2::Repository::discover(root) {
        Ok(r) => r,
        Err(_) => return map,
    };

    let statuses = match repo.statuses(Some(
        git2::StatusOptions::new()
            .include_untracked(true)
            .recurse_untracked_dirs(true),
    )) {
        Ok(s) => s,
        Err(_) => return map,
    };

    let workdir = match repo.workdir() {
        Some(w) => w.to_path_buf(),
        None => return map,
    };

    for entry in statuses.iter() {
        let status = entry.status();
        let status_str = if status.contains(git2::Status::WT_NEW)
            || status.contains(git2::Status::INDEX_NEW)
        {
            "added"
        } else if status.contains(git2::Status::WT_MODIFIED)
            || status.contains(git2::Status::INDEX_MODIFIED)
        {
            "modified"
        } else if status.contains(git2::Status::WT_DELETED)
            || status.contains(git2::Status::INDEX_DELETED)
        {
            "deleted"
        } else if status.contains(git2::Status::WT_RENAMED)
            || status.contains(git2::Status::INDEX_RENAMED)
        {
            "renamed"
        } else if status.contains(git2::Status::CONFLICTED) {
            "conflicted"
        } else if status.contains(git2::Status::IGNORED) {
            continue; // skip ignored files
        } else {
            continue;
        };

        if let Some(path_str) = entry.path() {
            let full_path = workdir.join(path_str);
            map.insert(full_path, status_str.to_string());
        }
    }

    map
}

/// Recursively build the file tree.
fn build_tree(
    dir: &Path,
    depth: u32,
    max_depth: u32,
    git_map: &HashMap<PathBuf, String>,
) -> Result<Vec<FileTreeEntry>, AppError> {
    if depth >= max_depth {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();

    let read_dir = std::fs::read_dir(dir)
        .map_err(|e| AppError::Internal(format!("Failed to read directory {}: {}", dir.display(), e)))?;

    let mut dir_entries: Vec<std::fs::DirEntry> = read_dir
        .filter_map(|e| e.ok())
        .collect();

    // Sort: directories first, then alphabetically
    dir_entries.sort_by(|a, b| {
        let a_is_dir = a.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
        let b_is_dir = b.file_type().map(|ft| ft.is_dir()).unwrap_or(false);
        match (a_is_dir, b_is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.file_name().cmp(&b.file_name()),
        }
    });

    for dir_entry in dir_entries {
        let name = dir_entry.file_name().to_string_lossy().to_string();
        let path = dir_entry.path();
        let is_dir = dir_entry.file_type()
            .map(|ft| ft.is_dir())
            .unwrap_or(false);

        // Skip hidden and known directories
        if is_dir && SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }

        let path_str = path.to_string_lossy().to_string();

        if is_dir {
            let children = build_tree(&path, depth + 1, max_depth, git_map)?;
            // Derive git status for directory from children
            let dir_git_status = derive_dir_git_status(&children);
            entries.push(FileTreeEntry {
                name,
                path: path_str,
                is_dir: true,
                children: Some(children),
                git_status: dir_git_status,
            });
        } else {
            let git_status = git_map.get(&path).cloned();
            entries.push(FileTreeEntry {
                name,
                path: path_str,
                is_dir: false,
                children: None,
                git_status,
            });
        }
    }

    Ok(entries)
}

/// Derive git status for a directory based on its children.
/// If any child has a git status, the directory gets "modified".
fn derive_dir_git_status(children: &[FileTreeEntry]) -> Option<String> {
    for child in children {
        if child.git_status.is_some() {
            return Some("modified".to_string());
        }
        if let Some(ref grandchildren) = child.children {
            if derive_dir_git_status(grandchildren).is_some() {
                return Some("modified".to_string());
            }
        }
    }
    None
}

#[tauri::command]
pub async fn get_file_tree(
    root_path: String,
    depth: Option<u32>,
) -> Result<Vec<FileTreeEntry>, AppError> {
    let root = PathBuf::from(&root_path);
    if !root.is_dir() {
        return Err(AppError::BadRequest(format!(
            "Path is not a directory: {}",
            root_path
        )));
    }

    let max_depth = depth.unwrap_or(10);
    let git_map = build_git_status_map(&root);
    let tree = build_tree(&root, 0, max_depth, &git_map)?;
    Ok(tree)
}

/// Returns the path to ~/.claude/settings.json (or empty string if home dir not found).
#[tauri::command]
pub async fn get_claude_settings_path() -> String {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|home| {
            std::path::PathBuf::from(home)
                .join(".claude")
                .join("settings.json")
                .to_string_lossy()
                .to_string()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub async fn read_file_content(path: String) -> Result<String, AppError> {
    let file_path = PathBuf::from(&path);
    if !file_path.is_file() {
        return Err(AppError::NotFound(format!("File not found: {}", path)));
    }
    std::fs::read_to_string(&file_path)
        .map_err(|e| AppError::Internal(format!("Failed to read file {}: {}", path, e)))
}

#[tauri::command]
pub async fn save_file_content(path: String, content: String) -> Result<(), AppError> {
    let file_path = PathBuf::from(&path);
    // Ensure parent directory exists
    if let Some(parent) = file_path.parent() {
        if !parent.exists() {
            return Err(AppError::NotFound(format!(
                "Parent directory does not exist: {}",
                parent.display()
            )));
        }
    }
    std::fs::write(&file_path, &content)
        .map_err(|e| AppError::Internal(format!("Failed to save file {}: {}", path, e)))
}

#[tauri::command]
pub async fn delete_file(path: String) -> Result<(), AppError> {
    let file_path = PathBuf::from(&path);
    if !file_path.exists() {
        return Err(AppError::NotFound(format!("File not found: {}", path)));
    }
    if file_path.is_dir() {
        std::fs::remove_dir_all(&file_path)
            .map_err(|e| AppError::Internal(format!("Failed to delete directory {}: {}", path, e)))
    } else {
        std::fs::remove_file(&file_path)
            .map_err(|e| AppError::Internal(format!("Failed to delete file {}: {}", path, e)))
    }
}

#[tauri::command]
pub async fn get_file_at_head(file_path: String) -> Result<String, AppError> {
    let path = PathBuf::from(&file_path);

    // Discover the repository from the file path
    let repo = git2::Repository::discover(&path)
        .map_err(|e| AppError::Internal(format!("Failed to open git repo: {}", e)))?;

    let workdir = repo
        .workdir()
        .ok_or_else(|| AppError::Internal("Bare repository has no working directory".to_string()))?;

    // Get the relative path from repo root
    let relative_path = path.strip_prefix(workdir).map_err(|_| {
        AppError::BadRequest(format!(
            "File {} is not within the repository working directory",
            file_path
        ))
    })?;

    // Get the HEAD commit tree
    let head = repo
        .head()
        .map_err(|e| AppError::Internal(format!("Failed to get HEAD: {}", e)))?;
    let commit = head
        .peel_to_commit()
        .map_err(|e| AppError::Internal(format!("Failed to peel HEAD to commit: {}", e)))?;
    let tree = commit
        .tree()
        .map_err(|e| AppError::Internal(format!("Failed to get commit tree: {}", e)))?;

    // Look up the file in the tree - use forward slashes for git paths
    let git_path = relative_path.to_string_lossy().replace('\\', "/");
    let tree_entry = tree
        .get_path(Path::new(&git_path))
        .map_err(|_| AppError::NotFound(format!("File not found in HEAD: {}", git_path)))?;

    // Get the blob content
    let blob = repo
        .find_blob(tree_entry.id())
        .map_err(|e| AppError::Internal(format!("Failed to read blob: {}", e)))?;

    let content = String::from_utf8_lossy(blob.content()).to_string();
    Ok(content)
}
