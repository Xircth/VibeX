use std::{
    ffi::OsString,
    path::{Component, Path, PathBuf},
};

use serde::Serialize;

use crate::error::AppError;

mod filesystem_ops;
mod git_head;
mod listing;
mod preview;
mod search;

use filesystem_ops::{
    copy_item_path, create_directory_at_path, delete_file_or_directory, move_item_path,
    read_file_content_at_path, resolve_existing_file_path, save_file_content_at_path,
};
use git_head::get_file_at_head_content;
pub use listing::{DirectoryChildrenResponse, FileTreeEntry};
use listing::{get_file_tree_entries, list_directory_children_at_path};
pub use preview::BinaryAssetResponse;
use preview::read_binary_asset_file;
use search::search_workspace_text_at_path;
pub use search::{TextSearchFileResult, TextSearchMatch, TextSearchOptions, TextSearchResponse};

// Path safety

/// Sanitize a user-supplied file path to prevent path traversal attacks.
///
/// When sandbox roots are not available (commands without AppState), this
/// function provides defense-in-depth by:
/// 1. Rejecting paths with `..` components
/// 2. Canonicalizing to resolve symlinks
/// 3. Verifying the canonical path does not escape the original path's parent
///    hierarchy (detects symlink escapes)
fn sanitize_file_path(path: &str) -> Result<PathBuf, AppError> {
    let normalized_path = normalize_windows_verbatim_input(path);
    let p = PathBuf::from(&normalized_path);

    // Reject any path containing parent-dir (`..`) components
    for comp in p.components() {
        if matches!(comp, Component::ParentDir) {
            return Err(AppError::BadRequest(
                "Path traversal not allowed: '..' components rejected".to_string(),
            ));
        }
    }

    // Must be an absolute path to prevent relative-path tricks
    if !p.is_absolute() {
        return Err(AppError::BadRequest(
            "Only absolute paths are accepted".to_string(),
        ));
    }

    // Canonicalize to resolve symlinks and normalize the path
    let canonical = if p.exists() {
        p.canonicalize()
            .map_err(|e| AppError::Internal(format!("Failed to resolve path {}: {}", path, e)))?
    } else if let Some(parent) = p.parent() {
        if parent.exists() {
            let canonical_parent = parent
                .canonicalize()
                .map_err(|e| AppError::Internal(format!("Failed to resolve parent path: {}", e)))?;
            canonical_parent.join(p.file_name().unwrap_or_default())
        } else {
            return Err(AppError::BadRequest(format!(
                "Parent directory does not exist for path: {}",
                normalized_path
            )));
        }
    } else {
        return Err(AppError::BadRequest(format!(
            "Cannot resolve path: {}",
            normalized_path
        )));
    };

    // Additional safety: reject if canonical path contains `..` after resolution
    // (should not happen but acts as a safety net)
    for comp in canonical.components() {
        if matches!(comp, Component::ParentDir) {
            return Err(AppError::BadRequest(
                "Resolved path still contains '..' components".to_string(),
            ));
        }
    }

    Ok(canonical)
}

fn sanitize_directory_creation_path(path: &str) -> Result<PathBuf, AppError> {
    let normalized_path = normalize_windows_verbatim_input(path);
    let p = PathBuf::from(&normalized_path);

    for comp in p.components() {
        if matches!(comp, Component::ParentDir) {
            return Err(AppError::BadRequest(
                "Path traversal not allowed: '..' components rejected".to_string(),
            ));
        }
    }

    if !p.is_absolute() {
        return Err(AppError::BadRequest(
            "Only absolute paths are accepted".to_string(),
        ));
    }

    if p.exists() {
        return p
            .canonicalize()
            .map_err(|e| AppError::Internal(format!("Failed to resolve path {}: {}", path, e)));
    }

    let mut ancestor = p.as_path();
    let mut missing_segments: Vec<OsString> = Vec::new();
    while !ancestor.exists() {
        let segment = ancestor.file_name().ok_or_else(|| {
            AppError::BadRequest(format!("Cannot resolve path: {}", normalized_path))
        })?;
        missing_segments.push(segment.to_os_string());
        ancestor = ancestor.parent().ok_or_else(|| {
            AppError::BadRequest(format!("Cannot resolve path: {}", normalized_path))
        })?;
    }

    let mut resolved = ancestor.canonicalize().map_err(|e| {
        AppError::Internal(format!(
            "Failed to resolve parent path {}: {}",
            ancestor.display(),
            e
        ))
    })?;
    if !resolved.is_dir() {
        return Err(AppError::BadRequest(format!(
            "Parent path is not a directory: {}",
            resolved.display()
        )));
    }

    for segment in missing_segments.iter().rev() {
        resolved.push(segment);
    }

    for comp in resolved.components() {
        if matches!(comp, Component::ParentDir) {
            return Err(AppError::BadRequest(
                "Resolved path still contains '..' components".to_string(),
            ));
        }
    }

    Ok(resolved)
}

#[cfg(windows)]
fn normalize_windows_verbatim_input(path: &str) -> String {
    fn marker_len_at(path: &str, index: usize) -> Option<usize> {
        let rest = path.get(index..)?;
        let bytes = rest.as_bytes();
        let looks_like_drive = |offset: usize| {
            bytes
                .get(offset)
                .is_some_and(|byte| byte.is_ascii_alphabetic())
                && bytes.get(offset + 1) == Some(&b':')
                && bytes
                    .get(offset + 2)
                    .is_some_and(|byte| *byte == b'\\' || *byte == b'/')
        };

        if bytes.len() >= 7
            && bytes[0] == b'\\'
            && bytes[1] == b'\\'
            && bytes[2] == b'?'
            && (bytes[3] == b'\\' || bytes[3] == b'/')
            && looks_like_drive(4)
        {
            return Some(4);
        }

        if bytes.len() >= 6
            && (bytes[0] == b'\\' || bytes[0] == b'/')
            && bytes[1] == b'?'
            && (bytes[2] == b'\\' || bytes[2] == b'/')
            && looks_like_drive(3)
        {
            return Some(3);
        }

        None
    }

    let mut last_marker = None;
    for (index, _) in path.char_indices() {
        if let Some(marker_len) = marker_len_at(path, index) {
            last_marker = Some((index, marker_len));
        }
    }

    let Some((index, marker_len)) = last_marker else {
        return path.to_string();
    };

    let candidate = &path[index + marker_len..];
    candidate.replace('/', "\\")
}

#[cfg(not(windows))]
fn normalize_windows_verbatim_input(path: &str) -> String {
    path.to_string()
}

fn read_utf8_text_file(path: &Path, display_path: &str) -> Result<String, AppError> {
    let bytes = std::fs::read(path)
        .map_err(|e| AppError::Internal(format!("Failed to read file {}: {}", display_path, e)))?;

    if bytes.contains(&0) {
        return Err(AppError::BadRequest(format!(
            "Binary file cannot be opened as text: {}",
            display_path
        )));
    }

    String::from_utf8(bytes).map_err(|_| {
        AppError::BadRequest(format!(
            "Binary file cannot be opened as text: {}",
            display_path
        ))
    })
}

// Response types

#[derive(Debug, Serialize, Clone)]
pub struct ReadFileResponse {
    pub content: String,
    pub truncated: bool,
}

// Constants

const MAX_READ_FILE_BYTES: usize = 512 * 1024;

// Tauri commands

#[tauri::command]
pub async fn get_file_tree(
    root_path: String,
    depth: Option<u32>,
) -> Result<Vec<FileTreeEntry>, AppError> {
    get_file_tree_entries(&root_path, depth)
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
    read_file_content_at_path(&path)
}

#[tauri::command]
pub async fn read_binary_asset(path: String) -> Result<BinaryAssetResponse, AppError> {
    let file_path = sanitize_file_path(&path)?;
    if !file_path.is_file() {
        return Err(AppError::NotFound(format!("File not found: {}", path)));
    }

    read_binary_asset_file(&file_path, &path)
}

#[tauri::command]
pub async fn save_file_content(path: String, content: String) -> Result<(), AppError> {
    save_file_content_at_path(&path, &content)
}

#[tauri::command]
pub async fn delete_file(path: String) -> Result<(), AppError> {
    delete_file_or_directory(&path)
}

#[tauri::command]
pub async fn get_file_at_head(file_path: String) -> Result<String, AppError> {
    get_file_at_head_content(&file_path)
}

// Directory listing commands

/// List directory children with gitignore classification.
///
/// When `relative_path` is empty or None, recursively scans the full tree
/// (skipping special directories like node_modules, target, etc.) and returns
/// all file/directory paths relative to `root_path`.
///
/// When `relative_path` is provided, lists only direct children of that
/// subdirectory (used for lazy-loading special directories).
#[tauri::command]
pub async fn list_directory_children(
    root_path: String,
    relative_path: String,
) -> Result<DirectoryChildrenResponse, AppError> {
    list_directory_children_at_path(&root_path, &relative_path)
}

/// Recursively scan tree from root, skipping special directories.
/// Returns all files/directories as paths relative to root.
/// Read file content with truncation support.
#[tauri::command]
pub async fn read_file_with_truncation(
    path: String,
    max_bytes: Option<usize>,
) -> Result<ReadFileResponse, AppError> {
    let file_path = resolve_existing_file_path(&path)?;

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
    let item_path = sanitize_file_path(&path)?;
    if !item_path.exists() {
        return Err(AppError::NotFound(format!("Item not found: {}", path)));
    }

    trash::delete(&item_path)
        .map_err(|e| AppError::Internal(format!("Failed to move to trash {}: {}", path, e)))
}

/// Copy a file or directory, returning the new path.
#[tauri::command]
pub async fn copy_item(path: String) -> Result<String, AppError> {
    copy_item_path(&path)
}

/// Move a file or directory to a new absolute path.
#[tauri::command]
pub async fn move_item(path: String, new_path: String) -> Result<String, AppError> {
    move_item_path(&path, &new_path)
}

/// Create a directory (including parents).
#[tauri::command]
pub async fn create_directory(path: String) -> Result<(), AppError> {
    create_directory_at_path(&path)
}

/// Search workspace text content.
#[tauri::command]
pub async fn search_workspace_text(
    root_path: String,
    options: TextSearchOptions,
) -> Result<TextSearchResponse, AppError> {
    search_workspace_text_at_path(&root_path, options)
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        io::Write,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::{
        copy_item_path, create_directory_at_path, delete_file_or_directory, move_item_path,
        read_file_content_at_path, read_utf8_text_file, sanitize_file_path,
        save_file_content_at_path,
    };
    use crate::error::AppError;

    fn temp_file_path(prefix: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("vibex-{prefix}-{unique}.tmp"))
    }

    fn temp_dir_path(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("vibex-{prefix}-{unique}"))
    }

    fn create_temp_dir(prefix: &str) -> PathBuf {
        let path = temp_dir_path(prefix);
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn path_string(path: &Path) -> String {
        path.to_string_lossy().to_string()
    }

    #[test]
    fn sanitize_file_path_rejects_relative_and_parent_components() {
        let relative_error = sanitize_file_path("relative.txt").unwrap_err();
        assert!(matches!(relative_error, AppError::BadRequest(_)));

        let root = create_temp_dir("sanitize-parent");
        let traversal_path = root.join("..").join("escape.txt");
        let traversal_error = sanitize_file_path(&path_string(&traversal_path)).unwrap_err();
        let _ = fs::remove_dir_all(&root);

        assert!(matches!(traversal_error, AppError::BadRequest(_)));
        assert!(traversal_error.to_string().contains("Path traversal"));
    }

    #[test]
    fn file_content_helpers_save_and_read_utf8_files() {
        let root = create_temp_dir("file-content");
        let file_path = root.join("note.txt");

        save_file_content_at_path(&path_string(&file_path), "hello").unwrap();
        let content = read_file_content_at_path(&path_string(&file_path)).unwrap();
        let _ = fs::remove_dir_all(&root);

        assert_eq!(content, "hello");
    }

    #[test]
    fn save_file_content_rejects_missing_parent() {
        let root = create_temp_dir("save-missing-parent");
        let missing_child = root.join("missing").join("note.txt");

        let error = save_file_content_at_path(&path_string(&missing_child), "hello").unwrap_err();
        let _ = fs::remove_dir_all(&root);

        assert!(matches!(error, AppError::BadRequest(_)));
        assert!(
            error
                .to_string()
                .contains("Parent directory does not exist")
        );
    }

    #[test]
    fn delete_file_or_directory_removes_files_and_directories() {
        let root = create_temp_dir("delete-item");
        let file_path = root.join("note.txt");
        fs::write(&file_path, "hello").unwrap();
        let dir_path = root.join("folder");
        fs::create_dir_all(dir_path.join("child")).unwrap();
        fs::write(dir_path.join("child").join("note.txt"), "nested").unwrap();

        delete_file_or_directory(&path_string(&file_path)).unwrap();
        delete_file_or_directory(&path_string(&dir_path)).unwrap();
        let _ = fs::remove_dir_all(&root);

        assert!(!file_path.exists());
        assert!(!dir_path.exists());
    }

    #[test]
    fn copy_item_path_uses_unique_copy_names_for_files() {
        let root = create_temp_dir("copy-file");
        let file_path = root.join("note.txt");
        let first_copy = root.join("note_copy.txt");
        fs::write(&file_path, "source").unwrap();
        fs::write(&first_copy, "existing").unwrap();

        let copied_path = PathBuf::from(copy_item_path(&path_string(&file_path)).unwrap());
        let copied_content = fs::read_to_string(&copied_path).unwrap();
        let _ = fs::remove_dir_all(&root);

        assert_eq!(copied_path.file_name().unwrap(), "note_copy_2.txt");
        assert_eq!(copied_content, "source");
    }

    #[test]
    fn copy_item_path_recursively_copies_directories() {
        let root = create_temp_dir("copy-dir");
        let source_dir = root.join("folder");
        let nested_file = source_dir.join("child").join("note.txt");
        fs::create_dir_all(nested_file.parent().unwrap()).unwrap();
        fs::write(&nested_file, "nested").unwrap();

        let copied_path = PathBuf::from(copy_item_path(&path_string(&source_dir)).unwrap());
        let copied_content =
            fs::read_to_string(copied_path.join("child").join("note.txt")).unwrap();
        let _ = fs::remove_dir_all(&root);

        assert_eq!(copied_path.file_name().unwrap(), "folder_copy");
        assert_eq!(copied_content, "nested");
    }

    #[test]
    fn move_item_path_moves_files_and_rejects_existing_destinations() {
        let root = create_temp_dir("move-file");
        let source = root.join("source.txt");
        let destination = root.join("destination.txt");
        let conflict = root.join("conflict.txt");
        fs::write(&source, "source").unwrap();
        fs::write(&conflict, "conflict").unwrap();

        let moved_path = move_item_path(&path_string(&source), &path_string(&destination)).unwrap();
        let error = move_item_path(&moved_path, &path_string(&conflict)).unwrap_err();
        let destination_content = fs::read_to_string(&destination).unwrap();
        let _ = fs::remove_dir_all(&root);

        assert_eq!(
            PathBuf::from(moved_path).file_name().unwrap(),
            "destination.txt"
        );
        assert!(!source.exists());
        assert_eq!(destination_content, "source");
        assert!(matches!(error, AppError::Conflict(_)));
    }

    #[test]
    fn move_item_path_rejects_moving_directory_into_itself() {
        let root = create_temp_dir("move-dir-self");
        let source_dir = root.join("folder");
        fs::create_dir_all(&source_dir).unwrap();
        let destination = source_dir.join("child");

        let error =
            move_item_path(&path_string(&source_dir), &path_string(&destination)).unwrap_err();
        let _ = fs::remove_dir_all(&root);

        assert!(matches!(error, AppError::BadRequest(_)));
        assert!(
            error
                .to_string()
                .contains("Cannot move a directory into itself")
        );
    }

    #[test]
    fn create_directory_at_path_creates_leaf_when_parent_exists() {
        let root = create_temp_dir("create-dir");
        let child = root.join("child");

        create_directory_at_path(&path_string(&child)).unwrap();
        assert!(child.is_dir());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn create_directory_at_path_creates_missing_parents() {
        let root = create_temp_dir("create-dir-parents");
        let nested = root.join("parent").join("child");

        create_directory_at_path(&path_string(&nested)).unwrap();
        assert!(nested.is_dir());

        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn normalize_windows_verbatim_input_extracts_real_path_from_duplicated_path() {
        let duplicated = r"\\?\C:\Users\Administrator\Documents\Projects\self\gameCard\\\?\C:\Users\Administrator\Documents\Projects\self\gameCard\app.py";

        assert_eq!(
            super::normalize_windows_verbatim_input(duplicated),
            r"C:\Users\Administrator\Documents\Projects\self\gameCard\app.py"
        );
    }

    #[test]
    fn read_utf8_text_file_accepts_plain_utf8() {
        let path = temp_file_path("utf8");
        let mut file = std::fs::File::create(&path).unwrap();
        writeln!(file, "hello world").unwrap();
        drop(file);

        let content = read_utf8_text_file(&path, &path.display().to_string()).unwrap();
        let _ = std::fs::remove_file(&path);

        assert!(content.contains("hello world"));
    }

    #[test]
    fn read_utf8_text_file_rejects_binary_bytes() {
        let path = temp_file_path("binary");
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A])
            .unwrap();
        drop(file);

        let error = read_utf8_text_file(&path, &path.display().to_string()).unwrap_err();
        let _ = std::fs::remove_file(&path);

        assert!(matches!(error, AppError::BadRequest(_)));
        assert!(
            error
                .to_string()
                .contains("Binary file cannot be opened as text")
        );
    }
}
