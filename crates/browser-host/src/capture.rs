//! Viewport and element screenshot capture, cropping, and scaling.

use std::io::Cursor;

use base64::Engine as _;
use image::imageops::FilterType;
use image::{DynamicImage, GenericImageView, ImageFormat};
use serde::{Deserialize, Serialize};

use crate::agent::SnapshotViewport;

pub const DEFAULT_MAX_WIDTH: u32 = 1280;
pub const MAX_MAX_WIDTH: u32 = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum CaptureFormat {
    #[default]
    Png,
    Jpeg,
}

impl CaptureFormat {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "png" => Some(Self::Png),
            "jpeg" | "jpg" => Some(Self::Jpeg),
            _ => None,
        }
    }

    pub fn mime(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation: Option<String>,
    #[serde(rename = "ref", default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_width: Option<u32>,
    #[serde(default)]
    pub format: CaptureFormat,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRegion {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageCapture {
    pub url: String,
    pub mime: String,
    pub data: String,
    pub width: u32,
    pub height: u32,
    pub clipped: bool,
    pub region: CaptureRegion,
}

pub fn finish_capture(
    png_bytes: &[u8],
    url: String,
    viewport: &SnapshotViewport,
    region: Option<CaptureRegion>,
    request: &CaptureRequest,
) -> Result<PageCapture, String> {
    let decoded = image::load_from_memory_with_format(png_bytes, ImageFormat::Png)
        .or_else(|_| image::load_from_memory(png_bytes))
        .map_err(|e| format!("cannot decode screenshot: {e}"))?;
    let (raw_w, raw_h) = decoded.dimensions();
    if raw_w == 0 || raw_h == 0 {
        return Err("the screenshot has zero size".to_string());
    }

    let (cropped, region_out, clipped) = match region {
        Some(r) => {
            let (img, actual) = crop_to_region(decoded, viewport, r)?;
            (img, actual, true)
        }
        None => (
            decoded,
            CaptureRegion {
                x: 0.0,
                y: 0.0,
                width: viewport.width.max(1.0),
                height: viewport.height.max(1.0),
            },
            false,
        ),
    };

    let cap = request
        .max_width
        .unwrap_or(DEFAULT_MAX_WIDTH)
        .clamp(1, MAX_MAX_WIDTH);
    let scaled = scale_down(cropped, cap);
    let (width, height) = scaled.dimensions();

    // Encode as PNG (or if JPEG was requested, PNG is still valid and lossless when JPEG feature is off,
    // or we report the actual encoded format).
    let mut bytes = Vec::new();
    scaled
        .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
        .map_err(|e| format!("cannot encode screenshot: {e}"))?;
    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);

    Ok(PageCapture {
        url,
        mime: CaptureFormat::Png.mime().to_string(),
        data,
        width,
        height,
        clipped,
        region: region_out,
    })
}

fn crop_to_region(
    image: DynamicImage,
    viewport: &SnapshotViewport,
    region: CaptureRegion,
) -> Result<(DynamicImage, CaptureRegion), String> {
    let (img_w, img_h) = image.dimensions();
    let scale_x = if viewport.width > 0.0 {
        f64::from(img_w) / viewport.width
    } else {
        viewport.dpr.max(1.0)
    };
    let scale_y = if viewport.height > 0.0 {
        f64::from(img_h) / viewport.height
    } else {
        viewport.dpr.max(1.0)
    };

    let left = (region.x.max(0.0) * scale_x).floor() as u32;
    let top = (region.y.max(0.0) * scale_y).floor() as u32;
    let right = ((region.x + region.width).max(0.0) * scale_x)
        .ceil()
        .min(f64::from(img_w)) as u32;
    let bottom = ((region.y + region.height).max(0.0) * scale_y)
        .ceil()
        .min(f64::from(img_h)) as u32;

    if right <= left || bottom <= top {
        return Err("the requested element box lies outside the captured viewport".to_string());
    }

    let w = right - left;
    let h = bottom - top;
    let cropped = image.crop_imm(left, top, w, h);
    let actual = CaptureRegion {
        x: f64::from(left) / scale_x,
        y: f64::from(top) / scale_y,
        width: f64::from(w) / scale_x,
        height: f64::from(h) / scale_y,
    };
    Ok((cropped, actual))
}

fn scale_down(image: DynamicImage, max_width: u32) -> DynamicImage {
    let (w, h) = image.dimensions();
    if w <= max_width || max_width == 0 {
        return image;
    }
    let next_h = ((u64::from(h) * u64::from(max_width) + u64::from(w) / 2) / u64::from(w))
        .max(1) as u32;
    image.resize_exact(max_width, next_h, FilterType::Triangle)
}
