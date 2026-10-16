//! Content-addressed spill for timeline image bytes.
//!
//! The folded transcript keeps the original payload. The outbound timeline row
//! replaces those bytes with `vibex-image:{sha256}` so the renderer never holds
//! the bitmap until a visible, expanded image asks for that one hash.

use std::{
    fs, io,
    path::{Path, PathBuf},
};

use base64::{
    Engine,
    engine::general_purpose::{STANDARD, STANDARD_NO_PAD},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::conversation::{ContentBlock, ImageData};

pub const TIMELINE_IMAGE_URI_PREFIX: &str = "vibex-image:";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimelineImageBytes {
    pub mime_type: String,
    pub data_base64: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Debug)]
pub enum TimelineImageError {
    InvalidHash,
    NotFound,
    Io(io::Error),
}

impl std::fmt::Display for TimelineImageError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidHash => write!(formatter, "invalid timeline image hash"),
            Self::NotFound => write!(formatter, "timeline image not found"),
            Self::Io(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for TimelineImageError {}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ImageSidecar {
    mime_type: String,
    width: Option<u32>,
    height: Option<u32>,
}

pub fn externalize_image_data(image: &mut ImageData) {
    externalize_image_data_in(image, &default_timeline_image_dir());
}

pub fn externalize_image_data_in(image: &mut ImageData, dir: &Path) {
    if image.data.is_empty() {
        return;
    }
    let bytes = decode_payload(&image.data);
    if image.width.is_none() || image.height.is_none() {
        if let Some((width, height)) = image_dimensions(&bytes) {
            if image.width.is_none() {
                image.width = Some(width);
            }
            if image.height.is_none() {
                image.height = Some(height);
            }
        }
    }
    let hash = hex_encode(&Sha256::digest(&bytes));
    let _ = write_once(
        dir,
        &hash,
        &bytes,
        &image.mime_type,
        image.width,
        image.height,
    );
    image.data.clear();
    image.uri = Some(format!("{TIMELINE_IMAGE_URI_PREFIX}{hash}"));
}

pub fn spill_content_block(block: &mut ContentBlock) {
    spill_content_block_in(block, &default_timeline_image_dir());
}

pub fn spill_content_block_in(block: &mut ContentBlock, dir: &Path) {
    match block {
        ContentBlock::Image {
            data,
            mime_type,
            uri,
            width,
            height,
        } => {
            let mut image = ImageData {
                data: std::mem::take(data),
                mime_type: mime_type.clone(),
                uri: uri.clone(),
                width: *width,
                height: *height,
            };
            externalize_image_data_in(&mut image, dir);
            *data = image.data;
            *uri = image.uri;
            *width = image.width;
            *height = image.height;
        }
        ContentBlock::ImageGeneration { image, .. } => {
            if let Some(image) = image {
                externalize_image_data_in(image, dir);
            }
        }
        ContentBlock::ToolUse { images, .. } => {
            for image in images {
                externalize_image_data_in(image, dir);
            }
        }
        _ => {}
    }
}

pub fn read_timeline_image(hash: &str) -> Result<TimelineImageBytes, TimelineImageError> {
    read_timeline_image_in(&default_timeline_image_dir(), hash)
}

pub fn read_timeline_image_in(
    dir: &Path,
    hash: &str,
) -> Result<TimelineImageBytes, TimelineImageError> {
    let hash = hash.trim().to_ascii_lowercase();
    if !is_sha256_hex(&hash) {
        return Err(TimelineImageError::InvalidHash);
    }
    let dir = dir
        .canonicalize()
        .map_err(|_| TimelineImageError::NotFound)?;
    let path = dir.join(format!("{hash}.bin"));
    let file = path
        .canonicalize()
        .map_err(|_| TimelineImageError::NotFound)?;
    if !file.starts_with(&dir) {
        return Err(TimelineImageError::InvalidHash);
    }
    let bytes = fs::read(&file).map_err(TimelineImageError::Io)?;
    let sidecar = fs::read(dir.join(format!("{hash}.json")))
        .ok()
        .and_then(|raw| serde_json::from_slice::<ImageSidecar>(&raw).ok())
        .unwrap_or(ImageSidecar {
            mime_type: "application/octet-stream".to_string(),
            width: None,
            height: None,
        });
    Ok(TimelineImageBytes {
        mime_type: sidecar.mime_type,
        data_base64: STANDARD.encode(bytes),
        width: sidecar.width,
        height: sidecar.height,
    })
}

fn default_timeline_image_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("VIBEX_TIMELINE_IMAGE_DIR") {
        return PathBuf::from(dir);
    }
    #[cfg(test)]
    {
        return std::env::temp_dir().join("vibex-timeline-images-test");
    }
    #[cfg(not(test))]
    {
        dirs::data_local_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("vibex")
            .join("timeline-images")
    }
}

fn decode_payload(data: &str) -> Vec<u8> {
    let trimmed = data.trim();
    if let Ok(bytes) = STANDARD.decode(trimmed) {
        return bytes;
    }
    if let Ok(bytes) = STANDARD_NO_PAD.decode(trimmed) {
        return bytes;
    }
    trimmed.as_bytes().to_vec()
}

fn write_once(
    dir: &Path,
    hash: &str,
    bytes: &[u8],
    mime_type: &str,
    width: Option<u32>,
    height: Option<u32>,
) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let bin = dir.join(format!("{hash}.bin"));
    if bin.exists() {
        return Ok(());
    }
    fs::write(&bin, bytes)?;
    let sidecar = ImageSidecar {
        mime_type: mime_type.to_string(),
        width,
        height,
    };
    if let Ok(raw) = serde_json::to_vec(&sidecar) {
        fs::write(dir.join(format!("{hash}.json")), raw)?;
    }
    Ok(())
}

fn is_sha256_hex(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn image_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() >= 24 && bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
        let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
        return Some((width, height));
    }
    jpeg_dimensions(bytes)
}

fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return None;
    }
    let mut index = 2;
    while index + 1 < bytes.len() {
        if bytes[index] != 0xFF {
            index += 1;
            continue;
        }
        while index < bytes.len() && bytes[index] == 0xFF {
            index += 1;
        }
        if index >= bytes.len() {
            return None;
        }
        let marker = bytes[index];
        index += 1;
        if marker == 0xD8 || marker == 0xD9 || (0xD0..=0xD7).contains(&marker) || marker == 0x01 {
            continue;
        }
        if index + 1 >= bytes.len() {
            return None;
        }
        let len = u16::from_be_bytes([bytes[index], bytes[index + 1]]) as usize;
        if len < 2 || index + len > bytes.len() {
            return None;
        }
        let sof = matches!(
            marker,
            0xC0 | 0xC1
                | 0xC2
                | 0xC3
                | 0xC5
                | 0xC6
                | 0xC7
                | 0xC9
                | 0xCA
                | 0xCB
                | 0xCD
                | 0xCE
                | 0xCF
        );
        if sof && len >= 7 {
            let height = u16::from_be_bytes([bytes[index + 3], bytes[index + 4]]) as u32;
            let width = u16::from_be_bytes([bytes[index + 5], bytes[index + 6]]) as u32;
            return Some((width, height));
        }
        index += len;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spilled_image_roundtrips_by_hash_and_rejects_escapes() {
        let dir =
            std::env::temp_dir().join(format!("vibex-timeline-image-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let mut image = ImageData {
            data: "AAAA".to_string(),
            mime_type: "image/png".to_string(),
            uri: Some("assets/logo.png".to_string()),
            width: None,
            height: None,
        };
        externalize_image_data_in(&mut image, &dir);
        assert!(image.data.is_empty());
        let hash = image
            .uri
            .as_deref()
            .and_then(|uri| uri.strip_prefix(TIMELINE_IMAGE_URI_PREFIX))
            .expect("content address");
        assert_eq!(hash.len(), 64);
        let loaded = read_timeline_image_in(&dir, hash).expect("read");
        assert_eq!(loaded.data_base64, "AAAA");
        assert_eq!(loaded.mime_type, "image/png");
        assert!(read_timeline_image_in(&dir, "../secret").is_err());
        assert!(read_timeline_image_in(&dir, &format!("..\\{hash}")).is_err());
        assert!(read_timeline_image_in(&dir, "not-a-hash").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn png_dimensions_are_recorded_without_keeping_bytes() {
        let dir =
            std::env::temp_dir().join(format!("vibex-timeline-image-png-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let mut bytes = vec![0u8; 24];
        bytes[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        bytes[12..16].copy_from_slice(b"IHDR");
        bytes[16..20].copy_from_slice(&32u32.to_be_bytes());
        bytes[20..24].copy_from_slice(&16u32.to_be_bytes());
        let mut image = ImageData {
            data: STANDARD.encode(&bytes),
            mime_type: "image/png".to_string(),
            uri: None,
            width: None,
            height: None,
        };
        externalize_image_data_in(&mut image, &dir);
        assert_eq!(image.width, Some(32));
        assert_eq!(image.height, Some(16));
        assert!(image.data.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn empty_data_keeps_an_existing_uri() {
        let dir =
            std::env::temp_dir().join(format!("vibex-timeline-image-empty-{}", std::process::id()));
        let mut image = ImageData {
            data: String::new(),
            mime_type: "image/png".to_string(),
            uri: Some(".vibe-images/shot.png".to_string()),
            width: None,
            height: None,
        };
        externalize_image_data_in(&mut image, &dir);
        assert_eq!(image.uri.as_deref(), Some(".vibe-images/shot.png"));
    }
}
