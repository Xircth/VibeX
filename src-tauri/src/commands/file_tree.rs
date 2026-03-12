use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use ignore::WalkBuilder;
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};

use crate::error::AppError;

// ── Existing types ──

#[derive(Debug, Serialize, Clone)]
pub struct FileTreeEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Option<Vec<FileTreeEntry>>,
    pub git_status: Option<String>,
}

// ── New types for directory listing ──

#[derive(Debug, Serialize, Clone)]
pub struct DirectoryChildrenResponse {
    pub files: Vec<String>,
    pub directories: Vec<String>,
    pub gitignored_files: Vec<String>,
    pub gitignored_directories: Vec<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct TextSearchMatch {
    pub line: usize,
    pub column: usize,
    pub end_column: usize,
    pub preview: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct TextSearchFileResult {
    pub path: String,
    pub match_count: usize,
    pub matches: Vec<TextSearchMatch>,
}

#[derive(Debug, Serialize, Clone)]
pub struct TextSearchResponse {
    pub files: Vec<TextSearchFileResult>,
    pub file_count: usize,
    pub match_count: usize,
    pub limit_hit: bool,
}

#[derive(Debug, Deserialize)]
pub struct TextSearchOptions {
    pub query: String,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub is_regex: bool,
    pub include_pattern: Option<String>,
    pub exclude_pattern: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
pub struct ReadFileResponse {
    pub content: String,
    pub truncated: bool,
}

// ── Constants ──

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

const MAX_SEARCH_MATCHES: usize = 1_000;
const MAX_SEARCH_FILE_BYTES: u64 = 1_024 * 1_024;
const MAX_PREVIEW_CHARS: usize = 180;
const SCAN_ENTRY_BUDGET: usize = 30_000;
const SCAN_TIME_BUDGET: Duration = Duration::from_millis(1_200);
const MAX_READ_FILE_BYTES: usize = 512 * 1024;

fn is_special_dir(name: &str) -> bool {
    DEPENDENCY_DIRS.contains(&name) || BUILD_ARTIFACT_DIRS.contains(&name)
}

fn should_skip_dir(name: &str) -> bool {
    SKIP_DIRS.contains(&name)
}

fn scan_budget_reached(started_at: Instant, scanned: usize) -> bool {
    scanned >= SCAN_ENTRY_BUDGET || started_at.elapsed() >= SCAN_TIME_BUDGET
}

fn normalize_path(path: &str) -> String {
    path.replace('\\', "/")
}

// ── Git status helpers ──

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
            continue;
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

/// Recursively build the file tree (existing implementation).
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
        AppError::Internal(format!(
            "Failed to read directory {}: {}",
            dir.display(),
            e
        ))
    })?;

    let mut dir_entries: Vec<std::fs::DirEntry> =
        read_dir.filter_map(|e| e.ok()).collect();

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
        if let Some(ref grandchildren) = child.children {
            if derive_dir_git_status(grandchildren).is_some() {
                return Some("modified".to_string());
            }
        }
    }
    None
}

// ── Search helpers ──

fn compile_search_regex(
    query: &str,
    options: &TextSearchOptions,
) -> Result<Regex, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Err("Search query cannot be empty.".to_string());
    }
    let pattern = if options.is_regex {
        trimmed.to_string()
    } else {
        regex::escape(trimmed)
    };
    let pattern = if options.whole_word {
        format!(r"\b(?:{})\b", pattern)
    } else {
        pattern
    };
    RegexBuilder::new(&pattern)
        .case_insensitive(!options.case_sensitive)
        .build()
        .map_err(|error| format!("Invalid search pattern: {error}"))
}

fn glob_to_regex(pattern: &str) -> Result<Regex, String> {
    let normalized = pattern.replace('\\', "/").trim().trim_matches('/').to_string();
    if normalized.is_empty() {
        return Err("Glob pattern cannot be empty.".to_string());
    }
    let mut regex_src = String::from("^");
    let chars: Vec<char> = normalized.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '*' {
            if chars.get(i + 1).copied() == Some('*') {
                regex_src.push_str(".*");
                i += 2;
                continue;
            }
            regex_src.push_str("[^/]*");
            i += 1;
            continue;
        }
        if c == '?' {
            regex_src.push_str("[^/]");
            i += 1;
            continue;
        }
        if matches!(c, '.' | '+' | '(' | ')' | '|' | '^' | '$' | '{' | '}' | '[' | ']' | '\\') {
            regex_src.push('\\');
        }
        regex_src.push(c);
        i += 1;
    }
    regex_src.push('$');
    Regex::new(&regex_src).map_err(|e| format!("Invalid glob `{pattern}`: {e}"))
}

fn compile_globs(input: Option<&str>) -> Result<Vec<Regex>, String> {
    match input {
        None => Ok(Vec::new()),
        Some(s) => s
            .split([',', '\n'])
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(glob_to_regex)
            .collect(),
    }
}

fn matches_any(path: &str, patterns: &[Regex]) -> bool {
    patterns.iter().any(|p| p.is_match(path))
}

fn build_preview(line: &str, start: usize, end: usize) -> String {
    let chars: Vec<char> = line.chars().collect();
    if chars.len() <= MAX_PREVIEW_CHARS {
        return line.trim().to_string();
    }
    let start_char = line[..start].chars().count();
    let end_char = line[..end].chars().count();
    let context = MAX_PREVIEW_CHARS / 2;
    let slice_start = start_char.saturating_sub(context / 2);
    let slice_end = (end_char + context).min(chars.len());
    let mut preview: String = chars[slice_start..slice_end].iter().collect();
    if slice_start > 0 {
        preview = format!("...{preview}");
    }
    if slice_end < chars.len() {
        preview.push_str("...");
    }
    preview.trim().to_string()
}

// ══════════════════════════════════════════════════════
//  TAURI COMMANDS — Existing
// ══════════════════════════════════════════════════════

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

    let repo = git2::Repository::discover(&path)
        .map_err(|e| AppError::Internal(format!("Failed to open git repo: {}", e)))?;

    let workdir = repo
        .workdir()
        .ok_or_else(|| AppError::Internal("Bare repository has no working directory".to_string()))?;

    let relative_path = path.strip_prefix(workdir).map_err(|_| {
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

    let content = String::from_utf8_lossy(blob.content()).to_string();
    Ok(content)
}

// ══════════════════════════════════════════════════════
//  TAURI COMMANDS — New (from mossx)
// ══════════════════════════════════════════════════════

/// List direct children of a directory with gitignore classification.
#[tauri::command]
pub async fn list_directory_children(
    root_path: String,
    relative_path: Option<String>,
) -> Result<DirectoryChildrenResponse, AppError> {
    let root = PathBuf::from(&root_path);
    if !root.is_dir() {
        return Err(AppError::BadRequest(format!(
            "Root path is not a directory: {}",
            root_path
        )));
    }

    let target_dir = match &relative_path {
        Some(rel) => {
            let sanitized = rel.trim().replace('\\', "/");
            let trimmed = sanitized.trim_matches('/');
            // Validate no parent directory traversal
            let p = Path::new(trimmed);
            for comp in p.components() {
                if matches!(comp, Component::ParentDir | Component::RootDir | Component::Prefix(_)) {
                    return Err(AppError::BadRequest("Invalid path".to_string()));
                }
            }
            root.join(trimmed)
        }
        None => root.clone(),
    };

    if !target_dir.is_dir() {
        return Err(AppError::NotFound(format!(
            "Directory not found: {}",
            target_dir.display()
        )));
    }

    let repo = git2::Repository::discover(&root).ok();
    let started_at = Instant::now();
    let mut scanned = 0usize;

    let mut files = Vec::new();
    let mut directories = Vec::new();
    let mut gitignored_files = Vec::new();
    let mut gitignored_directories = Vec::new();

    let read_dir = std::fs::read_dir(&target_dir).map_err(|e| {
        AppError::Internal(format!("Failed to read directory: {}", e))
    })?;

    let mut dir_entries: Vec<std::fs::DirEntry> = read_dir
        .filter_map(|e| {
            if scan_budget_reached(started_at, scanned) {
                return None;
            }
            scanned += 1;
            e.ok()
        })
        .collect();

    dir_entries.sort_by(|a, b| a.file_name().cmp(&b.file_name()));

    for entry in dir_entries {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };

        // Check gitignore status
        let rel_from_root = path.strip_prefix(&root).unwrap_or(&path);
        let is_ignored = repo
            .as_ref()
            .and_then(|r| r.status_should_ignore(rel_from_root).ok())
            .unwrap_or(false);

        if file_type.is_dir() {
            if should_skip_dir(&name) {
                continue;
            }
            directories.push(name.clone());
            if is_ignored {
                gitignored_directories.push(name);
            }
        } else if file_type.is_file() {
            if name == ".DS_Store" {
                continue;
            }
            files.push(name.clone());
            if is_ignored {
                gitignored_files.push(name);
            }
        }
    }

    Ok(DirectoryChildrenResponse {
        files,
        directories,
        gitignored_files,
        gitignored_directories,
    })
}

/// Read file content with truncation support.
#[tauri::command]
pub async fn read_file_with_truncation(
    path: String,
    max_bytes: Option<usize>,
) -> Result<ReadFileResponse, AppError> {
    let file_path = PathBuf::from(&path);
    if !file_path.is_file() {
        return Err(AppError::NotFound(format!("File not found: {}", path)));
    }

    let limit = max_bytes.unwrap_or(MAX_READ_FILE_BYTES);
    let bytes = std::fs::read(&file_path)
        .map_err(|e| AppError::Internal(format!("Failed to read file {}: {}", path, e)))?;

    let truncated = bytes.len() > limit;
    let slice = if truncated { &bytes[..limit] } else { &bytes };
    let content = String::from_utf8_lossy(slice).to_string();

    Ok(ReadFileResponse { content, truncated })
}

/// Move file/directory to system trash (recycle bin).
#[tauri::command]
pub async fn trash_item(path: String) -> Result<(), AppError> {
    let item_path = PathBuf::from(&path);
    if !item_path.exists() {
        return Err(AppError::NotFound(format!("Item not found: {}", path)));
    }

    trash::delete(&item_path).map_err(|e| {
        AppError::Internal(format!("Failed to move to trash {}: {}", path, e))
    })
}

/// Copy a file or directory, returning the new path.
#[tauri::command]
pub async fn copy_item(path: String) -> Result<String, AppError> {
    let source = PathBuf::from(&path);
    if !source.exists() {
        return Err(AppError::NotFound(format!("Item not found: {}", path)));
    }

    let parent = source.parent().ok_or_else(|| {
        AppError::Internal("Cannot determine parent directory".to_string())
    })?;

    let stem = source
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let ext = source
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();

    // Find unique name: stem_copy.ext, stem_copy_2.ext, etc.
    let mut dest;
    let mut counter = 0u32;
    loop {
        let suffix = if counter == 0 {
            "_copy".to_string()
        } else {
            format!("_copy_{}", counter + 1)
        };
        let new_name = if source.is_dir() {
            format!("{}{}", stem, suffix)
        } else {
            format!("{}{}{}", stem, suffix, ext)
        };
        dest = parent.join(&new_name);
        if !dest.exists() {
            break;
        }
        counter += 1;
        if counter > 100 {
            return Err(AppError::Internal("Too many copies exist".to_string()));
        }
    }

    if source.is_dir() {
        copy_dir_recursive(&source, &dest)?;
    } else {
        std::fs::copy(&source, &dest).map_err(|e| {
            AppError::Internal(format!("Failed to copy file: {}", e))
        })?;
    }

    Ok(dest.to_string_lossy().to_string())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), AppError> {
    std::fs::create_dir_all(dst).map_err(|e| {
        AppError::Internal(format!("Failed to create directory {}: {}", dst.display(), e))
    })?;

    for entry in std::fs::read_dir(src).map_err(|e| {
        AppError::Internal(format!("Failed to read directory {}: {}", src.display(), e))
    })? {
        let entry = entry.map_err(|e| AppError::Internal(format!("Read dir error: {}", e)))?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());

        if src_path.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            std::fs::copy(&src_path, &dst_path).map_err(|e| {
                AppError::Internal(format!("Failed to copy: {}", e))
            })?;
        }
    }
    Ok(())
}

/// Create a directory (including parents).
#[tauri::command]
pub async fn create_directory(path: String) -> Result<(), AppError> {
    let dir_path = PathBuf::from(&path);
    std::fs::create_dir_all(&dir_path).map_err(|e| {
        AppError::Internal(format!("Failed to create directory {}: {}", path, e))
    })
}

/// Search workspace text content.
#[tauri::command]
pub async fn search_workspace_text(
    root_path: String,
    options: TextSearchOptions,
) -> Result<TextSearchResponse, AppError> {
    let root = PathBuf::from(&root_path);
    if !root.is_dir() {
        return Err(AppError::BadRequest(format!(
            "Root path is not a directory: {}",
            root_path
        )));
    }

    let regex = compile_search_regex(&options.query, &options)
        .map_err(AppError::BadRequest)?;
    let include_patterns = compile_globs(options.include_pattern.as_deref())
        .map_err(AppError::BadRequest)?;
    let exclude_patterns = compile_globs(options.exclude_pattern.as_deref())
        .map_err(AppError::BadRequest)?;

    let root_for_filter = root.clone();
    let walker = WalkBuilder::new(&root)
        .hidden(false)
        .follow_links(false)
        .require_git(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .filter_entry(move |entry| {
            if entry.depth() == 0 {
                return true;
            }
            let name = entry.file_name().to_string_lossy();
            if entry.file_type().is_some_and(|ft| ft.is_dir()) {
                if should_skip_dir(&name) {
                    return false;
                }
                if let Ok(rel) = entry.path().strip_prefix(&root_for_filter) {
                    let normalized = normalize_path(&rel.to_string_lossy());
                    if !normalized.is_empty() && is_special_dir(normalized.rsplit('/').next().unwrap_or("")) {
                        return false;
                    }
                }
            }
            name != ".DS_Store"
        })
        .build();

    let mut files = Vec::new();
    let mut total_files = 0usize;
    let mut total_matches = 0usize;
    let mut limit_hit = false;

    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().is_some_and(|ft| ft.is_file()) {
            continue;
        }
        let rel_path = match entry.path().strip_prefix(&root) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let normalized = normalize_path(&rel_path.to_string_lossy());
        if normalized.is_empty() {
            continue;
        }
        if !include_patterns.is_empty() && !matches_any(&normalized, &include_patterns) {
            continue;
        }
        if !exclude_patterns.is_empty() && matches_any(&normalized, &exclude_patterns) {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if metadata.len() > MAX_SEARCH_FILE_BYTES {
            continue;
        }
        let bytes = match std::fs::read(entry.path()) {
            Ok(b) => b,
            Err(_) => continue,
        };
        // Skip binary files
        if bytes.contains(&0) {
            continue;
        }
        let content = String::from_utf8_lossy(&bytes);
        let mut file_matches = Vec::new();
        let mut file_match_count = 0usize;

        for (line_idx, line) in content.lines().enumerate() {
            for capture in regex.find_iter(line) {
                file_match_count += 1;
                total_matches += 1;
                if file_matches.len() < 50 {
                    file_matches.push(TextSearchMatch {
                        line: line_idx + 1,
                        column: line[..capture.start()].chars().count() + 1,
                        end_column: line[..capture.end()].chars().count() + 1,
                        preview: build_preview(line, capture.start(), capture.end()),
                    });
                }
                if total_matches >= MAX_SEARCH_MATCHES {
                    limit_hit = true;
                    break;
                }
            }
            if limit_hit {
                break;
            }
        }

        if file_match_count > 0 {
            total_files += 1;
            files.push(TextSearchFileResult {
                path: normalized,
                match_count: file_match_count,
                matches: file_matches,
            });
        }
        if limit_hit {
            break;
        }
    }

    Ok(TextSearchResponse {
        files,
        file_count: total_files,
        match_count: total_matches,
        limit_hit,
    })
}
