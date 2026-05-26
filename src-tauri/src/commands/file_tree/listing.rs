use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
    time::{Duration, Instant},
};

use ignore::WalkBuilder;
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

#[derive(Debug, Serialize, Clone)]
pub struct DirectoryChildrenResponse {
    pub files: Vec<String>,
    pub directories: Vec<String>,
    pub gitignored_files: Vec<String>,
    pub gitignored_directories: Vec<String>,
    pub truncated: bool,
}

const SKIP_DIRS: &[&str] = &[".git"];

const DEPENDENCY_DIRS: &[&str] = &[
    "node_modules",
    ".pnpm-store",
    ".yarn",
    "bower_components",
    "vendor",
    ".venv",
    "venv",
    "env",
    "__pypackages__",
    "Pods",
    "Carthage",
    ".m2",
    ".ivy2",
    ".cargo",
];

const BUILD_ARTIFACT_DIRS: &[&str] = &[
    "target",
    "dist",
    "build",
    "out",
    "coverage",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".angular",
    ".parcel-cache",
    ".turbo",
    ".cache",
    ".gradle",
    "CMakeFiles",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".tox",
    ".dart_tool",
];

const SCAN_ENTRY_BUDGET: usize = 30_000;
const SCAN_TIME_BUDGET: Duration = Duration::from_millis(1_200);

pub(super) fn is_special_dir(name: &str) -> bool {
    DEPENDENCY_DIRS.contains(&name) || BUILD_ARTIFACT_DIRS.contains(&name)
}

pub(super) fn should_skip_dir(name: &str) -> bool {
    SKIP_DIRS.contains(&name)
}

fn scan_budget_reached(started_at: Instant, scanned: usize) -> bool {
    scanned >= SCAN_ENTRY_BUDGET || started_at.elapsed() >= SCAN_TIME_BUDGET
}

pub(super) fn normalize_path(path: &str) -> String {
    path.replace('\\', "/")
}

pub(super) fn get_file_tree_entries(
    root_path: &str,
    depth: Option<u32>,
) -> Result<Vec<FileTreeEntry>, AppError> {
    let root = PathBuf::from(root_path);
    if !root.is_dir() {
        return Err(AppError::BadRequest(format!(
            "Path is not a directory: {}",
            root_path
        )));
    }

    let max_depth = depth.unwrap_or(10);
    let git_map = build_git_status_map(&root);
    build_tree(&root, 0, max_depth, &git_map)
}

pub(super) fn list_directory_children_at_path(
    root_path: &str,
    relative_path: &str,
) -> Result<DirectoryChildrenResponse, AppError> {
    let root = PathBuf::from(root_path);
    if !root.is_dir() {
        return Ok(DirectoryChildrenResponse {
            files: Vec::new(),
            directories: Vec::new(),
            gitignored_files: Vec::new(),
            gitignored_directories: Vec::new(),
            truncated: false,
        });
    }

    let trimmed = relative_path.trim().replace('\\', "/");
    let trimmed = trimmed.trim_matches('/');
    let is_root_scan = trimmed.is_empty();

    if !is_root_scan {
        let p = Path::new(trimmed);
        for comp in p.components() {
            if matches!(
                comp,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            ) {
                return Err(AppError::BadRequest("Invalid path".to_string()));
            }
        }
    }

    let repo = git2::Repository::discover(&root).ok();

    if is_root_scan {
        scan_tree_recursive(&root, &repo)
    } else {
        let target_dir = root.join(trimmed);
        if !target_dir.is_dir() {
            return Err(AppError::NotFound(format!(
                "Directory not found: {}",
                target_dir.display()
            )));
        }
        scan_single_directory(&root, &target_dir, &repo)
    }
}

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
        let status_str =
            if status.contains(git2::Status::WT_NEW) || status.contains(git2::Status::INDEX_NEW) {
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

    let read_dir = std::fs::read_dir(dir).map_err(|e| {
        AppError::Internal(format!("Failed to read directory {}: {}", dir.display(), e))
    })?;

    let mut dir_entries: Vec<std::fs::DirEntry> = read_dir.filter_map(|e| e.ok()).collect();

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
        let is_dir = dir_entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false);

        if is_dir && (should_skip_dir(&name) || is_special_dir(&name)) {
            continue;
        }

        let path_str = path.to_string_lossy().to_string();

        if is_dir {
            let children = build_tree(&path, depth + 1, max_depth, git_map)?;
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

fn derive_dir_git_status(children: &[FileTreeEntry]) -> Option<String> {
    for child in children {
        if child.git_status.is_some() {
            return Some("modified".to_string());
        }
        if let Some(ref grandchildren) = child.children
            && derive_dir_git_status(grandchildren).is_some()
        {
            return Some("modified".to_string());
        }
    }
    None
}

fn scan_tree_recursive(
    root: &Path,
    repo: &Option<git2::Repository>,
) -> Result<DirectoryChildrenResponse, AppError> {
    let started_at = Instant::now();
    let max_files = 10_000usize;
    let max_directories = 20_000usize;

    let mut files = Vec::new();
    let mut directories = Vec::new();
    let mut gitignored_files = Vec::new();
    let mut gitignored_directories = Vec::new();
    let mut truncated = false;

    let root_children = scan_single_directory(root, root, repo)?;
    files.extend(root_children.files);
    directories.extend(root_children.directories);
    gitignored_files.extend(root_children.gitignored_files);
    gitignored_directories.extend(root_children.gitignored_directories);
    truncated |= root_children.truncated;

    let root_clone = root.to_path_buf();
    let walker = WalkBuilder::new(root)
        .hidden(false)
        .follow_links(false)
        .require_git(false)
        .git_ignore(false)
        .filter_entry(move |entry| {
            if entry.depth() == 0 {
                return true;
            }
            let name = entry.file_name().to_string_lossy();
            if entry.file_type().is_some_and(|ft| ft.is_dir()) {
                if should_skip_dir(&name) {
                    return false;
                }
                if let Ok(rel_path) = entry.path().strip_prefix(&root_clone) {
                    let normalized = normalize_path(&rel_path.to_string_lossy());
                    if !normalized.is_empty() && is_special_dir(&name) {
                        return false;
                    }
                }
            }
            true
        })
        .build();

    for (scanned, result) in walker.enumerate() {
        if scan_budget_reached(started_at, scanned) {
            truncated = true;
            break;
        }

        let entry = match result {
            Ok(e) => e,
            Err(_) => continue,
        };

        if entry.depth() == 0 {
            continue;
        }

        let path = entry.path();
        let rel_path = match path.strip_prefix(root) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let normalized = normalize_path(&rel_path.to_string_lossy());
        if normalized.is_empty() {
            continue;
        }

        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().is_some_and(|ft| ft.is_dir());
        let is_file = entry.file_type().is_some_and(|ft| ft.is_file());

        let is_ignored = repo
            .as_ref()
            .and_then(|r| r.status_should_ignore(rel_path).ok())
            .unwrap_or(false);

        if is_dir {
            if directories.len() >= max_directories {
                truncated = true;
                continue;
            }
            directories.push(normalized.clone());
            if is_ignored {
                gitignored_directories.push(normalized);
            }
        } else if is_file {
            if name == ".DS_Store" {
                continue;
            }
            if files.len() >= max_files {
                truncated = true;
                break;
            }
            files.push(normalized.clone());
            if is_ignored {
                gitignored_files.push(normalized);
            }
        }
    }

    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let ft = match entry.file_type() {
                Ok(ft) => ft,
                Err(_) => continue,
            };
            if ft.is_dir() && is_special_dir(&name) && !should_skip_dir(&name) {
                let normalized = name.clone();
                if !directories.contains(&normalized) {
                    let rel_path = entry.path();
                    let rel_from_root = rel_path.strip_prefix(root).unwrap_or(&rel_path);
                    let is_ignored = repo
                        .as_ref()
                        .and_then(|r| r.status_should_ignore(rel_from_root).ok())
                        .unwrap_or(false);
                    directories.push(normalized.clone());
                    if is_ignored {
                        gitignored_directories.push(normalized);
                    }
                }
            }
        }
    }

    files.sort();
    files.dedup();
    directories.sort();
    directories.dedup();
    gitignored_files.sort();
    gitignored_files.dedup();
    gitignored_directories.sort();
    gitignored_directories.dedup();

    Ok(DirectoryChildrenResponse {
        files,
        directories,
        gitignored_files,
        gitignored_directories,
        truncated,
    })
}

fn scan_single_directory(
    root: &Path,
    target_dir: &Path,
    repo: &Option<git2::Repository>,
) -> Result<DirectoryChildrenResponse, AppError> {
    let started_at = Instant::now();
    let mut truncated = false;

    let mut files = Vec::new();
    let mut directories = Vec::new();
    let mut gitignored_files = Vec::new();
    let mut gitignored_directories = Vec::new();

    let read_dir = std::fs::read_dir(target_dir)
        .map_err(|e| AppError::Internal(format!("Failed to read directory: {}", e)))?;

    let mut dir_entries = Vec::new();
    for (scanned, entry) in read_dir.enumerate() {
        if scan_budget_reached(started_at, scanned) {
            truncated = true;
            break;
        }
        if let Ok(entry) = entry {
            dir_entries.push(entry);
        }
    }

    dir_entries.sort_by_key(|a| a.file_name());

    for entry in dir_entries {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };

        let rel_from_root = match path.strip_prefix(root) {
            Ok(p) => normalize_path(&p.to_string_lossy()),
            Err(_) => continue,
        };

        let is_ignored = repo
            .as_ref()
            .and_then(|r| r.status_should_ignore(Path::new(&rel_from_root)).ok())
            .unwrap_or(false);

        if file_type.is_dir() {
            if should_skip_dir(&name) {
                continue;
            }
            directories.push(rel_from_root.clone());
            if is_ignored {
                gitignored_directories.push(rel_from_root);
            }
        } else if file_type.is_file() {
            if name == ".DS_Store" {
                continue;
            }
            files.push(rel_from_root.clone());
            if is_ignored {
                gitignored_files.push(rel_from_root);
            }
        }
    }

    Ok(DirectoryChildrenResponse {
        files,
        directories,
        gitignored_files,
        gitignored_directories,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::{get_file_tree_entries, list_directory_children_at_path};
    use crate::error::AppError;

    fn create_temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("vibex-listing-{prefix}-{unique}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn path_string(path: &Path) -> String {
        path.to_string_lossy().to_string()
    }

    #[test]
    fn list_directory_children_rejects_parent_relative_path() {
        let root = create_temp_dir("reject-parent");

        let error = list_directory_children_at_path(&path_string(&root), "../outside").unwrap_err();
        let _ = fs::remove_dir_all(&root);

        assert!(matches!(error, AppError::BadRequest(_)));
        assert!(error.to_string().contains("Invalid path"));
    }

    #[test]
    fn list_directory_children_returns_root_relative_direct_children() {
        let root = create_temp_dir("single-dir");
        fs::create_dir_all(root.join("src").join("nested")).unwrap();
        fs::write(root.join("src").join("main.rs"), "fn main() {}").unwrap();
        fs::write(root.join("src").join(".DS_Store"), "ignored").unwrap();

        let listing = list_directory_children_at_path(&path_string(&root), "src").unwrap();
        let _ = fs::remove_dir_all(&root);

        assert_eq!(listing.files, vec!["src/main.rs"]);
        assert_eq!(listing.directories, vec!["src/nested"]);
        assert!(!listing.truncated);
    }

    #[test]
    fn root_scan_lists_special_directory_without_recursing_into_it() {
        let root = create_temp_dir("root-special");
        fs::create_dir_all(root.join("node_modules").join("pkg")).unwrap();
        fs::write(root.join("node_modules").join("pkg").join("index.js"), "").unwrap();
        fs::write(root.join("app.ts"), "").unwrap();

        let listing = list_directory_children_at_path(&path_string(&root), "").unwrap();
        let _ = fs::remove_dir_all(&root);

        assert!(listing.files.contains(&"app.ts".to_string()));
        assert!(listing.directories.contains(&"node_modules".to_string()));
        assert!(
            !listing
                .files
                .iter()
                .any(|path| path.contains("node_modules/"))
        );
        assert!(
            !listing
                .directories
                .iter()
                .any(|path| path == "node_modules/pkg")
        );
    }

    #[test]
    fn get_file_tree_skips_dependency_directories() {
        let root = create_temp_dir("tree-skip-special");
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(root.join("visible.txt"), "").unwrap();

        let tree = get_file_tree_entries(&path_string(&root), Some(3)).unwrap();
        let _ = fs::remove_dir_all(&root);

        assert!(tree.iter().any(|entry| entry.name == "visible.txt"));
        assert!(!tree.iter().any(|entry| entry.name == "node_modules"));
    }
}
