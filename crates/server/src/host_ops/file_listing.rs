use std::path::{Component, Path};

use application::ApplicationError;
use serde::Serialize;

use crate::domains::internal_error;

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
pub struct DirectoryChildrenListing {
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

const MAX_FILES: usize = 10_000;
const MAX_DIRECTORIES: usize = 20_000;

pub(crate) fn is_special_dir(name: &str) -> bool {
    DEPENDENCY_DIRS.contains(&name) || BUILD_ARTIFACT_DIRS.contains(&name)
}

pub(crate) fn should_skip_dir(name: &str) -> bool {
    SKIP_DIRS.contains(&name)
}

pub(crate) fn normalize_path(path: &str) -> String {
    path.replace('\\', "/")
}

fn relative_from_root(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let normalized = normalize_path(&relative.to_string_lossy());
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

fn empty_listing() -> DirectoryChildrenListing {
    DirectoryChildrenListing {
        files: Vec::new(),
        directories: Vec::new(),
        gitignored_files: Vec::new(),
        gitignored_directories: Vec::new(),
        truncated: false,
    }
}

fn finish_listing(
    mut files: Vec<String>,
    mut directories: Vec<String>,
    mut gitignored_files: Vec<String>,
    mut gitignored_directories: Vec<String>,
    truncated: bool,
) -> DirectoryChildrenListing {
    files.sort();
    files.dedup();
    directories.sort();
    directories.dedup();
    gitignored_files.sort();
    gitignored_files.dedup();
    gitignored_directories.sort();
    gitignored_directories.dedup();
    DirectoryChildrenListing {
        files,
        directories,
        gitignored_files,
        gitignored_directories,
        truncated,
    }
}

fn discover_repo(root: &Path) -> Option<git2::Repository> {
    git2::Repository::discover(root).ok()
}

fn path_is_gitignored(repo: Option<&git2::Repository>, relative: &str) -> bool {
    repo.and_then(|repo| repo.status_should_ignore(Path::new(relative)).ok())
        .unwrap_or(false)
}

pub fn build_git_status_map(root: &Path) -> std::collections::HashMap<std::path::PathBuf, String> {
    let mut map = std::collections::HashMap::new();
    let Some(repo) = git2::Repository::discover(root).ok() else {
        return map;
    };
    let Ok(statuses) = repo.statuses(Some(
        git2::StatusOptions::new()
            .include_untracked(true)
            .recurse_untracked_dirs(true),
    )) else {
        return map;
    };
    let Some(workdir) = repo.workdir().map(Path::to_path_buf) else {
        return map;
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
            map.insert(workdir.join(path_str), status_str.to_string());
        }
    }
    map
}

/// List the direct children of one workspace directory.
///
/// An empty `relative_path` lists `root` itself. Results are always
/// root-relative so lazy-loaded folders nest under their parent. This never
/// walks descendants: the file tree loads each folder when it is expanded.
pub fn list_directory_children_at_path(
    root: &Path,
    relative_path: &str,
) -> Result<DirectoryChildrenListing, ApplicationError> {
    if !root.is_dir() {
        return Ok(empty_listing());
    }

    let trimmed = normalize_path(relative_path.trim())
        .trim_matches('/')
        .to_string();
    let target_dir = if trimmed.is_empty() {
        root.to_path_buf()
    } else {
        let relative = Path::new(&trimmed);
        if relative.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            return Err(ApplicationError::bad_request("Invalid path"));
        }
        root.join(&trimmed)
    };

    if !target_dir.is_dir() {
        if trimmed.is_empty() {
            return Ok(empty_listing());
        }
        return Err(ApplicationError::not_found(format!(
            "Directory not found: {}",
            target_dir.display()
        )));
    }

    scan_single_directory(root, &target_dir)
}

fn classify_dir_entry(entry: &std::fs::DirEntry) -> Option<bool> {
    let file_type = entry.file_type().ok()?;
    if file_type.is_dir() {
        return Some(true);
    }
    if file_type.is_file() {
        return Some(false);
    }
    if !file_type.is_symlink() {
        return None;
    }
    let metadata = std::fs::metadata(entry.path()).ok()?;
    if metadata.is_dir() {
        Some(true)
    } else if metadata.is_file() {
        Some(false)
    } else {
        None
    }
}

fn scan_single_directory(
    root: &Path,
    target_dir: &Path,
) -> Result<DirectoryChildrenListing, ApplicationError> {
    let mut files = Vec::new();
    let mut directories = Vec::new();
    let mut gitignored_files = Vec::new();
    let mut gitignored_directories = Vec::new();
    let repo = discover_repo(root);

    let read_dir = std::fs::read_dir(target_dir).map_err(|error| {
        ApplicationError::internal(format!("Failed to read directory: {error}"))
    })?;

    for entry in read_dir {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(is_dir) = classify_dir_entry(&entry) else {
            continue;
        };
        let Some(relative) = relative_from_root(root, &entry.path()) else {
            continue;
        };

        if is_dir {
            if should_skip_dir(&name) {
                continue;
            }
            directories.push(relative.clone());
            if path_is_gitignored(repo.as_ref(), &relative) {
                gitignored_directories.push(relative);
            }
        } else {
            if name == ".DS_Store" {
                continue;
            }
            files.push(relative.clone());
            if path_is_gitignored(repo.as_ref(), &relative) {
                gitignored_files.push(relative);
            }
        }
    }

    let truncated = files.len() > MAX_FILES || directories.len() > MAX_DIRECTORIES;
    files.sort();
    directories.sort();
    if files.len() > MAX_FILES {
        files.truncate(MAX_FILES);
    }
    if directories.len() > MAX_DIRECTORIES {
        directories.truncate(MAX_DIRECTORIES);
    }
    gitignored_files.retain(|path| files.binary_search(path).is_ok());
    gitignored_directories.retain(|path| directories.binary_search(path).is_ok());

    Ok(finish_listing(
        files,
        directories,
        gitignored_files,
        gitignored_directories,
        truncated,
    ))
}

pub fn walk_file_tree(
    root: &Path,
    max_depth: u32,
    depth: u32,
    git_map: &std::collections::HashMap<std::path::PathBuf, String>,
) -> Result<Vec<serde_json::Value>, ApplicationError> {
    if depth >= max_depth {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    let mut dir_entries: Vec<std::fs::DirEntry> = std::fs::read_dir(root)
        .map_err(internal_error)?
        .filter_map(Result::ok)
        .collect();
    dir_entries.sort_by(|left, right| {
        let left_dir = left
            .file_type()
            .map(|file_type| file_type.is_dir())
            .unwrap_or(false);
        let right_dir = right
            .file_type()
            .map(|file_type| file_type.is_dir())
            .unwrap_or(false);
        match (left_dir, right_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => left.file_name().cmp(&right.file_name()),
        }
    });
    for entry in dir_entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        let is_dir = path.is_dir();
        if is_dir && should_skip_dir(&name) {
            continue;
        }
        let children = if is_dir && !is_special_dir(&name) && depth + 1 < max_depth {
            Some(walk_file_tree(&path, max_depth, depth + 1, git_map)?)
        } else if is_dir {
            Some(Vec::new())
        } else {
            None
        };
        let git_status = if is_dir {
            children.as_ref().and_then(|child_entries| {
                child_entries.iter().find_map(|child| {
                    if child
                        .get("git_status")
                        .and_then(serde_json::Value::as_str)
                        .is_some()
                    {
                        Some("modified".to_string())
                    } else {
                        None
                    }
                })
            })
        } else {
            git_map.get(&path).cloned()
        };
        entries.push(serde_json::json!({
            "name": name,
            "path": path.to_string_lossy(),
            "is_dir": is_dir,
            "children": children,
            "git_status": git_status,
        }));
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::list_directory_children_at_path;

    fn create_temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("vibex-host-listing-{prefix}-{unique}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn rejects_parent_relative_path() {
        let root = create_temp_dir("reject-parent");
        let error = list_directory_children_at_path(&root, "../outside").unwrap_err();
        let _ = fs::remove_dir_all(&root);
        assert!(error.to_string().contains("Invalid path"));
    }

    #[test]
    fn nested_listing_returns_root_relative_direct_children() {
        let root = create_temp_dir("single-dir");
        fs::create_dir_all(root.join("src").join("nested")).unwrap();
        fs::write(root.join("src").join("main.rs"), "fn main() {}").unwrap();
        fs::write(root.join("src").join(".DS_Store"), "ignored").unwrap();

        let listing = list_directory_children_at_path(&root, "src").unwrap();
        let _ = fs::remove_dir_all(&root);

        assert_eq!(listing.files, vec!["src/main.rs"]);
        assert_eq!(listing.directories, vec!["src/nested"]);
        assert!(!listing.truncated);
    }

    #[test]
    fn root_scan_lists_direct_children_only() {
        let root = create_temp_dir("root-nested");
        fs::create_dir_all(root.join("assets").join("icons")).unwrap();
        fs::write(root.join("assets").join("logo.png"), "").unwrap();
        fs::write(root.join("README.md"), "").unwrap();
        fs::create_dir_all(root.join(".claude")).unwrap();

        let listing = list_directory_children_at_path(&root, "").unwrap();
        let _ = fs::remove_dir_all(&root);

        assert_eq!(listing.files, vec!["README.md"]);
        assert_eq!(listing.directories, vec![".claude", "assets"]);
        assert!(!listing.truncated);
    }

    #[test]
    fn root_scan_keeps_later_sibling_directories() {
        let root = create_temp_dir("root-siblings");
        fs::create_dir_all(root.join("aaa").join("nested")).unwrap();
        for index in 0..80 {
            fs::write(root.join("aaa").join(format!("f{index}.txt")), "").unwrap();
        }
        fs::create_dir_all(root.join("zzz")).unwrap();
        fs::write(root.join("zzz").join("keep.txt"), "").unwrap();

        let listing = list_directory_children_at_path(&root, "").unwrap();
        let _ = fs::remove_dir_all(&root);

        assert_eq!(listing.directories, vec!["aaa", "zzz"]);
        assert!(listing.files.is_empty());
        assert!(!listing.truncated);
    }

    #[test]
    fn root_scan_lists_special_directory_without_recursing_into_it() {
        let root = create_temp_dir("root-special");
        fs::create_dir_all(root.join("node_modules").join("pkg")).unwrap();
        fs::write(root.join("node_modules").join("pkg").join("index.js"), "").unwrap();
        fs::write(root.join("app.ts"), "").unwrap();

        let listing = list_directory_children_at_path(&root, "").unwrap();
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
    fn missing_root_returns_empty_listing() {
        let listing =
            list_directory_children_at_path(Path::new("/definitely-missing-vibex-listing"), "")
                .unwrap();
        assert_eq!(listing, super::empty_listing());
    }

    #[test]
    fn root_scan_marks_gitignored_paths() {
        let root = create_temp_dir("gitignore");
        let _repo = git2::Repository::init(&root).unwrap();
        fs::write(root.join(".gitignore"), "secret.log\nignored-dir/\n").unwrap();
        fs::write(root.join("secret.log"), "hidden").unwrap();
        fs::write(root.join("visible.txt"), "ok").unwrap();
        fs::create_dir_all(root.join("ignored-dir")).unwrap();
        fs::write(root.join("ignored-dir").join("a.txt"), "hidden").unwrap();

        let listing = list_directory_children_at_path(&root, "").unwrap();
        let _ = fs::remove_dir_all(&root);

        assert!(listing.files.contains(&"secret.log".to_string()));
        assert!(listing.gitignored_files.contains(&"secret.log".to_string()));
        assert!(listing.directories.contains(&"ignored-dir".to_string()));
        assert!(
            listing
                .gitignored_directories
                .contains(&"ignored-dir".to_string())
        );
        assert!(
            !listing
                .gitignored_files
                .contains(&"visible.txt".to_string())
        );
    }

    #[cfg(unix)]
    #[test]
    fn lists_symlink_directories_as_folders() {
        let root = create_temp_dir("symlink-dir");
        fs::create_dir_all(root.join("real-folder")).unwrap();
        fs::write(root.join("real-folder").join("inside.txt"), "").unwrap();
        std::os::unix::fs::symlink(root.join("real-folder"), root.join("linked-folder")).unwrap();

        let listing = list_directory_children_at_path(&root, "").unwrap();
        let _ = fs::remove_dir_all(&root);

        assert!(listing.directories.contains(&"real-folder".to_string()));
        assert!(listing.directories.contains(&"linked-folder".to_string()));
        assert!(!listing.files.iter().any(|path| path == "linked-folder"));
    }
}
