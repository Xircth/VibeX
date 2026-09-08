use std::{
    fs,
    path::{Path, PathBuf},
};

use db::models::image::{CreateImage, Image};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum ImageError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Database error: {0}")]
    Database(#[from] sqlx::Error),

    #[error("Invalid image format")]
    InvalidFormat,

    #[error("File too large: {0} bytes (max: {1} bytes)")]
    TooLarge(u64, u64),

    #[error("Image not found")]
    NotFound,

    #[error("Failed to build response: {0}")]
    ResponseBuildError(String),
}

/// Sanitize filename for filesystem safety:
/// - Lowercase
/// - Spaces → underscores
/// - Remove special characters (keep alphanumeric and underscores)
/// - Truncate if too long
fn mime_type_for_extension(extension: &str) -> &'static str {
    match extension {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "m4v" => "video/x-m4v",
        "avi" => "video/x-msvideo",
        "mkv" => "video/x-matroska",
        "mpeg" | "mpg" => "video/mpeg",
        "pdf" => "application/pdf",
        "txt" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "json" => "application/json",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "xml" => "application/xml",
        "rtf" => "application/rtf",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

fn named_file_extension(filename: &str) -> Option<String> {
    let extension = Path::new(filename)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())?;
    if extension.is_empty() || extension.len() > 16 {
        return None;
    }
    if !extension
        .chars()
        .all(|character| character.is_ascii_alphanumeric())
    {
        return None;
    }
    Some(extension)
}

fn sniffed_image_extension(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("png");
    }
    if data.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("jpg");
    }
    if data.starts_with(b"GIF87a") || data.starts_with(b"GIF89a") {
        return Some("gif");
    }
    if data.len() >= 12 && data.starts_with(b"RIFF") && &data[8..12] == b"WEBP" {
        return Some("webp");
    }
    if data.starts_with(b"BM") {
        return Some("bmp");
    }
    if data.starts_with(b"<svg") || data.starts_with(b"<?xml") {
        return Some("svg");
    }
    None
}

fn sniffed_video_extension(data: &[u8]) -> Option<&'static str> {
    if data.len() >= 12 && &data[4..8] == b"ftyp" {
        let brand = &data[8..12];
        if matches!(brand, b"heic" | b"heif" | b"mif1" | b"avif" | b"avis") {
            return None;
        }
        if brand == b"qt  " {
            return Some("mov");
        }
        return Some("mp4");
    }
    if data.starts_with(&[0x1A, 0x45, 0xDF, 0xA3]) {
        return Some("webm");
    }
    if data.len() >= 12 && data.starts_with(b"RIFF") && &data[8..12] == b"AVI " {
        return Some("avi");
    }
    None
}

fn sniffed_document_extension(data: &[u8]) -> Option<&'static str> {
    if data.starts_with(b"%PDF") {
        return Some("pdf");
    }
    None
}

fn infer_stored_extension(filename: &str, data: &[u8]) -> String {
    named_file_extension(filename)
        .or_else(|| sniffed_image_extension(data).map(str::to_string))
        .or_else(|| sniffed_video_extension(data).map(str::to_string))
        .or_else(|| sniffed_document_extension(data).map(str::to_string))
        .unwrap_or_else(|| "bin".to_string())
}

fn sanitize_filename(name: &str) -> String {
    let stem = Path::new(name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("file");

    let clean: String = stem
        .to_lowercase()
        .chars()
        .map(|c| if c.is_whitespace() { '_' } else { c })
        .filter(|c| c.is_alphanumeric() || *c == '_')
        .collect();

    // Truncate to reasonable length to avoid filesystem limits
    let max_len = 50;
    if clean.len() > max_len {
        clean[..max_len].to_string()
    } else if clean.is_empty() {
        "file".to_string()
    } else {
        clean
    }
}

#[derive(Clone)]
pub struct ImageService {
    cache_dir: PathBuf,
    pool: SqlitePool,
    max_size_bytes: u64,
}

impl ImageService {
    pub fn new(pool: SqlitePool) -> Result<Self, ImageError> {
        let cache_dir = utils::assets::host_data_dir().join("images");
        fs::create_dir_all(&cache_dir)?;
        Ok(Self {
            cache_dir,
            pool,
            max_size_bytes: 100 * 1024 * 1024, // 100MB default
        })
    }

    pub async fn store_image(
        &self,
        data: &[u8],
        original_filename: &str,
    ) -> Result<Image, ImageError> {
        let file_size = data.len() as u64;

        if file_size > self.max_size_bytes {
            return Err(ImageError::TooLarge(file_size, self.max_size_bytes));
        }

        let hash = format!("{:x}", Sha256::digest(data));

        let extension = infer_stored_extension(original_filename, data);

        let mime_type = Some(mime_type_for_extension(&extension).to_string());

        let existing_image = Image::find_by_hash(&self.pool, &hash).await?;

        if let Some(existing) = existing_image {
            tracing::debug!("Reusing existing image record with hash {}", hash);
            return Ok(existing);
        }

        let clean_name = sanitize_filename(original_filename);
        let new_filename = format!("{}_{}.{}", Uuid::new_v4(), clean_name, extension);
        let cached_path = self.cache_dir.join(&new_filename);
        // store_image runs in an async context (it awaits DB calls); keep the
        // potentially multi-MB write off the async worker thread.
        tokio::fs::write(&cached_path, data).await?;

        let image = Image::create(
            &self.pool,
            &CreateImage {
                file_path: new_filename,
                original_name: original_filename.to_string(),
                mime_type,
                size_bytes: file_size as i64,
                hash,
            },
        )
        .await?;
        Ok(image)
    }

    pub async fn delete_orphaned_images(&self) -> Result<(), ImageError> {
        let orphaned_images = Image::find_orphaned_images(&self.pool).await?;
        if orphaned_images.is_empty() {
            tracing::debug!("No orphaned images found during cleanup");
            return Ok(());
        }

        tracing::debug!(
            "Found {} orphaned images to clean up",
            orphaned_images.len()
        );
        let mut deleted_count = 0;
        let mut failed_count = 0;

        for image in orphaned_images {
            match self.delete_image(image.id).await {
                Ok(_) => {
                    deleted_count += 1;
                    tracing::debug!("Deleted orphaned image: {}", image.id);
                }
                Err(e) => {
                    failed_count += 1;
                    tracing::error!("Failed to delete orphaned image {}: {}", image.id, e);
                }
            }
        }

        tracing::info!(
            "Image cleanup completed: {} deleted, {} failed",
            deleted_count,
            failed_count
        );

        Ok(())
    }

    pub fn get_absolute_path(&self, image: &Image) -> PathBuf {
        self.cache_dir.join(&image.file_path)
    }

    pub async fn get_image(&self, id: Uuid) -> Result<Option<Image>, ImageError> {
        Ok(Image::find_by_id(&self.pool, id).await?)
    }

    pub async fn delete_image(&self, id: Uuid) -> Result<(), ImageError> {
        if let Some(image) = Image::find_by_id(&self.pool, id).await? {
            let file_path = self.cache_dir.join(&image.file_path);
            if file_path.exists() {
                fs::remove_file(file_path)?;
            }

            Image::delete(&self.pool, id).await?;
        }

        Ok(())
    }

    pub async fn copy_images_by_task_to_worktree(
        &self,
        worktree_path: &Path,
        task_id: Uuid,
        agent_working_dir: Option<&str>,
    ) -> Result<(), ImageError> {
        let images = Image::find_by_task_id(&self.pool, task_id).await?;
        // When agent_working_dir is set, copy images to that subdirectory
        // so relative paths like .vibe-images/xxx.png work correctly
        let target_path = match agent_working_dir {
            Some(dir) if !dir.is_empty() => worktree_path.join(dir),
            _ => worktree_path.to_path_buf(),
        };
        self.copy_images(&target_path, images)
    }

    pub async fn copy_images_by_ids_to_worktree(
        &self,
        worktree_path: &Path,
        image_ids: &[Uuid],
    ) -> Result<(), ImageError> {
        let mut images = Vec::new();
        for id in image_ids {
            if let Some(image) = Image::find_by_id(&self.pool, *id).await? {
                images.push(image);
            }
        }
        self.copy_images(worktree_path, images)
    }

    /// Copy images to the worktree. Skips images that already exist at target.
    fn copy_images(&self, worktree_path: &Path, images: Vec<Image>) -> Result<(), ImageError> {
        if images.is_empty() {
            return Ok(());
        }

        let images_dir = worktree_path.join(utils::path::VIBE_IMAGES_DIR);

        // Fast path: check if all images exist before doing anything
        let all_exist = images
            .iter()
            .all(|image| images_dir.join(&image.file_path).exists());
        if all_exist {
            return Ok(());
        }

        std::fs::create_dir_all(&images_dir)?;

        // Create .gitignore to ignore all files in this directory
        let gitignore_path = images_dir.join(".gitignore");
        if !gitignore_path.exists() {
            std::fs::write(&gitignore_path, "*\n")?;
        }

        for image in images {
            let src = self.cache_dir.join(&image.file_path);
            let dst = images_dir.join(&image.file_path);

            if dst.exists() {
                continue;
            }

            if src.exists() {
                if let Err(e) = std::fs::copy(&src, &dst) {
                    tracing::error!("Failed to copy {}: {}", image.file_path, e);
                } else {
                    tracing::debug!("Copied {}", image.file_path);
                }
            } else {
                tracing::warn!("Missing cache file: {}", src.display());
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn infers_png_from_filename_or_magic_bytes() {
        let png = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 1, 2];
        assert_eq!(infer_stored_extension("shot.png", &[]), "png");
        assert_eq!(infer_stored_extension("", &png), "png");
        assert_eq!(infer_stored_extension("clipboard", &png), "png");
    }

    #[test]
    fn infers_video_from_filename_or_magic_bytes() {
        let mut mp4 = vec![0, 0, 0, 0x18];
        mp4.extend_from_slice(b"ftypmp42");
        mp4.extend_from_slice(&[0; 8]);
        let mut mov = vec![0, 0, 0, 0x18];
        mov.extend_from_slice(b"ftypqt  ");
        mov.extend_from_slice(&[0; 8]);
        assert_eq!(infer_stored_extension("clip.MP4", &[]), "mp4");
        assert_eq!(infer_stored_extension("demo.webm", &[]), "webm");
        assert_eq!(infer_stored_extension("", &mp4), "mp4");
        assert_eq!(infer_stored_extension("clipboard", &mov), "mov");
    }

    #[test]
    fn infers_document_extensions_from_filename() {
        assert_eq!(infer_stored_extension("notes.txt", b"hello"), "txt");
        assert_eq!(infer_stored_extension("readme.MD", &[]), "md");
        assert_eq!(infer_stored_extension("report.PDF", b"%PDF-1.4"), "pdf");
        assert_eq!(infer_stored_extension("letter.docx", &[]), "docx");
        assert_eq!(infer_stored_extension("clipboard", b"%PDF-1.7"), "pdf");
        assert_eq!(infer_stored_extension("clipboard", b"hello"), "bin");
    }
}
