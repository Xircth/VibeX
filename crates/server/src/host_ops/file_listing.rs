use std::{
    path::{Component, Path},
    time::{Duration, Instant},
};

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

const SCAN_ENTRY_BUDGET: usize = 30_000;
const SCAN_TIME_BUDGET: Duration = Duration::from_millis(1_200);
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

fn scan_budget_reached(started_at: Instant, scanned: usize) -> bool {
    scanned >= SCAN_ENTRY_BUDGET || started_at.elapsed() >= SCAN_TIME_BUDGET
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

/// List workspace files the file tree can render.
///
/// An empty `relative_path` recursively scans from `root` and returns every
/// discovered path relative to that root. Nested `relative_path` values list
/// only direct children, still as root-relative paths, so lazy-loaded folders
/// nest under their parent instead of appearing at the tree root.
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
    if trimmed.is_empty() {
        return scan_tree_recursive(root);
    }

    let relative = Path::new(&trimmed);
    if relative.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(ApplicationError::bad_request("Invalid path"));
    }

    let target_dir = root.join(&trimmed);
    if !target_dir.is_dir() {
        return Err(ApplicationError::not_found(format!(
            "Directory not found: {}",
            target_dir.display()
        )));
    }

    scan_single_directory(root, &target_dir)
}

fn scan_tree_recursive(root: &Path) -> Result<DirectoryChildrenListing, ApplicationError> {
    let started_at = Instant::now();
    let mut files = Vec::new();
    let mut directories = Vec::new();
    let mut gitignored_files = Vec::new();
    let mut gitignored_directories = Vec::new();
    let mut scanned = 0usize;
    let mut truncated = false;
    let repo = discover_repo(root);

    #[allow(clippy::too_many_arguments)]
    fn walk(
        root: &Path,
        dir: &Path,
        repo: Option<&git2::Repository>,
        started_at: Instant,
        scanned: &mut usize,
        files: &mut Vec<String>,
        directories: &mut Vec<String>,
        gitignored_files: &mut Vec<String>,
        gitignored_directories: &mut Vec<String>,
        truncated: &mut bool,
    ) -> Result<(), ApplicationError> {
        let read_dir = std::fs::read_dir(dir).map_err(internal_error)?;
        for entry in read_dir {
            if scan_budget_reached(started_at, *scanned) {
                *truncated = true;
                return Ok(());
            }
            *scanned += 1;

            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => continue,
            };
            let name = entry.file_name().to_string_lossy().into_owned();
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            let Some(relative) = relative_from_root(root, &entry.path()) else {
                continue;
            };

            if file_type.is_dir() {
                if should_skip_dir(&name) {
                    continue;
                }
                if directories.len() >= MAX_DIRECTORIES {
                    *truncated = true;
                    continue;
                }
                directories.push(relative.clone());
                if path_is_gitignored(repo, &relative) {
                    gitignored_directories.push(relative);
                }
                if is_special_dir(&name) {
                    continue;
                }
                walk(
                    root,
                    &entry.path(),
                    repo,
                    started_at,
                    scanned,
                    files,
                    directories,
                    gitignored_files,
                    gitignored_directories,
                    truncated,
                )?;
                if *truncated {
                    return Ok(());
                }
            } else if file_type.is_file() {
                if name == ".DS_Store" {
                    continue;
                }
                if files.len() >= MAX_FILES {
                    *truncated = true;
                    return Ok(());
                }
                files.push(relative.clone());
                if path_is_gitignored(repo, &relative) {
                    gitignored_files.push(relative);
                }
            }
        }
        Ok(())
    }

    walk(
        root,
        root,
        repo.as_ref(),
        started_at,
        &mut scanned,
        &mut files,
        &mut directories,
        &mut gitignored_files,
        &mut gitignored_directories,
        &mut truncated,
    )?;

    Ok(finish_listing(
        files,
        directories,
        gitignored_files,
        gitignored_directories,
        truncated,
    ))
}

fn scan_single_directory(
    root: &Path,
    target_dir: &Path,
) -> Result<DirectoryChildrenListing, ApplicationError> {
    let started_at = Instant::now();
    let mut files = Vec::new();
    let mut directories = Vec::new();
    let mut gitignored_files = Vec::new();
    let mut gitignored_directories = Vec::new();
    let mut truncated = false;
    let repo = discover_repo(root);

    let read_dir = std::fs::read_dir(target_dir).map_err(|error| {
        ApplicationError::internal(format!("Failed to read directory: {error}"))
    })?;

    for (scanned, entry) in read_dir.enumerate() {
        if scan_budget_reached(started_at, scanned) {
            truncated = true;
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => continue,
        };
        let Some(relative) = relative_from_root(root, &entry.path()) else {
            continue;
        };

        if file_type.is_dir() {
            if should_skip_dir(&name) {
                continue;
            }
            directories.push(relative.clone());
            if path_is_gitignored(repo.as_ref(), &relative) {
                gitignored_directories.push(relative);
            }
        } else if file_type.is_file() {
            if name == ".DS_Store" {
                continue;
            }
            files.push(relative.clone());
            if path_is_gitignored(repo.as_ref(), &relative) {
                gitignored_files.push(relative);
            }
        }
    }

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
    fn root_scan_includes_nested_paths_so_folders_can_expand() {
        let root = create_temp_dir("root-nested");
        fs::create_dir_all(root.join("assets").join("icons")).unwrap();
        fs::write(root.join("assets").join("logo.png"), "").unwrap();
        fs::write(root.join("README.md"), "").unwrap();
        fs::create_dir_all(root.join(".claude")).unwrap();

        let listing = list_directory_children_at_path(&root, "").unwrap();
        let _ = fs::remove_dir_all(&root);

        assert!(listing.files.contains(&"README.md".to_string()));
        assert!(listing.files.contains(&"assets/logo.png".to_string()));
        assert!(listing.directories.contains(&"assets".to_string()));
        assert!(listing.directories.contains(&"assets/icons".to_string()));
        assert!(listing.directories.contains(&".claude".to_string()));
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
}
