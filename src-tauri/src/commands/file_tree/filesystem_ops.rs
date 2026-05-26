use std::path::{Path, PathBuf};

use super::{read_utf8_text_file, sanitize_directory_creation_path, sanitize_file_path};
use crate::error::AppError;

pub(super) fn resolve_existing_file_path(path: &str) -> Result<PathBuf, AppError> {
    let file_path = sanitize_file_path(path)?;
    if !file_path.is_file() {
        return Err(AppError::NotFound(format!("File not found: {}", path)));
    }
    Ok(file_path)
}

pub(super) fn read_file_content_at_path(path: &str) -> Result<String, AppError> {
    let file_path = resolve_existing_file_path(path)?;
    read_utf8_text_file(&file_path, path)
}

pub(super) fn save_file_content_at_path(path: &str, content: &str) -> Result<(), AppError> {
    let file_path = sanitize_file_path(path)?;
    if let Some(parent) = file_path.parent()
        && !parent.exists()
    {
        return Err(AppError::NotFound(format!(
            "Parent directory does not exist: {}",
            parent.display()
        )));
    }
    std::fs::write(&file_path, content)
        .map_err(|e| AppError::Internal(format!("Failed to save file {}: {}", path, e)))
}

pub(super) fn delete_file_or_directory(path: &str) -> Result<(), AppError> {
    let file_path = sanitize_file_path(path)?;
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

pub(super) fn copy_item_path(path: &str) -> Result<String, AppError> {
    let source = sanitize_file_path(path)?;
    if !source.exists() {
        return Err(AppError::NotFound(format!("Item not found: {}", path)));
    }

    let parent = source
        .parent()
        .ok_or_else(|| AppError::Internal("Cannot determine parent directory".to_string()))?;

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
        std::fs::copy(&source, &dest)
            .map_err(|e| AppError::Internal(format!("Failed to copy file: {}", e)))?;
    }

    Ok(dest.to_string_lossy().to_string())
}

pub(super) fn move_item_path(path: &str, new_path: &str) -> Result<String, AppError> {
    let source = sanitize_file_path(path)?;
    if !source.exists() {
        return Err(AppError::NotFound(format!("Item not found: {}", path)));
    }

    let destination = sanitize_file_path(new_path)?;
    if source == destination {
        return Ok(destination.to_string_lossy().to_string());
    }

    if destination.exists() {
        return Err(AppError::Conflict(format!(
            "Destination already exists: {}",
            destination.display()
        )));
    }

    let destination_parent = destination.parent().ok_or_else(|| {
        AppError::BadRequest("Destination must include a parent directory".to_string())
    })?;

    if !destination_parent.exists() {
        return Err(AppError::NotFound(format!(
            "Destination parent does not exist: {}",
            destination_parent.display()
        )));
    }

    if !destination_parent.is_dir() {
        return Err(AppError::BadRequest(format!(
            "Destination parent is not a directory: {}",
            destination_parent.display()
        )));
    }

    if source.is_dir() && destination.starts_with(&source) {
        return Err(AppError::BadRequest(
            "Cannot move a directory into itself".to_string(),
        ));
    }

    std::fs::rename(&source, &destination).map_err(|e| {
        AppError::Internal(format!(
            "Failed to move {} to {}: {}",
            source.display(),
            destination.display(),
            e
        ))
    })?;

    Ok(destination.to_string_lossy().to_string())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), AppError> {
    std::fs::create_dir_all(dst).map_err(|e| {
        AppError::Internal(format!(
            "Failed to create directory {}: {}",
            dst.display(),
            e
        ))
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
            std::fs::copy(&src_path, &dst_path)
                .map_err(|e| AppError::Internal(format!("Failed to copy: {}", e)))?;
        }
    }
    Ok(())
}

pub(super) fn create_directory_at_path(path: &str) -> Result<(), AppError> {
    let dir_path = sanitize_directory_creation_path(path)?;
    std::fs::create_dir_all(&dir_path)
        .map_err(|e| AppError::Internal(format!("Failed to create directory {}: {}", path, e)))
}
