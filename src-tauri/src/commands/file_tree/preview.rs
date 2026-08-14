use std::path::Path;

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde::Serialize;

use crate::error::AppError;

#[derive(Debug, Serialize, Clone)]
pub struct BinaryAssetResponse {
    pub data_base64: String,
    pub mime_type: String,
}

fn mime_type_for_path(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .unwrap_or_default();

    match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "tif" | "tiff" => "image/tiff",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

pub(super) fn read_binary_asset_file(
    path: &Path,
    display_path: &str,
) -> Result<BinaryAssetResponse, AppError> {
    let bytes = std::fs::read(path).map_err(|error| {
        AppError::Internal(format!("Failed to read file {display_path}: {error}"))
    })?;

    Ok(BinaryAssetResponse {
        data_base64: BASE64.encode(bytes),
        mime_type: mime_type_for_path(path).to_string(),
    })
}

#[cfg(test)]
mod tests {
    use std::{
        io::Write,
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::read_binary_asset_file;

    #[test]
    fn read_binary_asset_file_returns_base64_and_mime_type() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("vibex-preview-png-{unique}.tmp"));
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A])
            .unwrap();
        drop(file);

        let asset = read_binary_asset_file(&path, &path.display().to_string()).unwrap();
        let _ = std::fs::remove_file(&path);

        assert_eq!(asset.mime_type, "application/octet-stream");
        assert!(!asset.data_base64.is_empty());
    }
}
