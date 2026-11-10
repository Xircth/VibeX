//! Viewport and element screenshot capture, cropping, and scaling.

use std::io::Cursor;

use base64::Engine as _;
use image::{DynamicImage, GenericImageView, ImageFormat, imageops::FilterType};
use serde::{Deserialize, Serialize};

use crate::agent::SnapshotViewport;

pub const DEFAULT_MAX_WIDTH: u32 = 1280;
pub const MAX_MAX_WIDTH: u32 = 4096;
pub const MIN_BURST_EVERY_MS: u32 = 50;
pub const MAX_BURST_OVER_MS: u32 = 10_000;

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub over_ms: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub every_ms: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reduced_motion: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color_scheme: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frames_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub over_ms: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub every_ms: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamps_ms: Option<Vec<u32>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub columns: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows: Option<u32>,
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
        frames_count: None,
        over_ms: None,
        every_ms: None,
        timestamps_ms: None,
        columns: None,
        rows: None,
    })
}

pub fn compose_contact_sheet(
    frames: &[(u32, Vec<u8>)],
    url: String,
    viewport: &SnapshotViewport,
    region: Option<CaptureRegion>,
    request: &CaptureRequest,
    over_ms: u32,
    every_ms: u32,
) -> Result<PageCapture, String> {
    if frames.is_empty() {
        return Err("no frames captured for contact sheet".to_string());
    }

    let count = frames.len() as u32;
    let columns = if count <= 1 {
        1
    } else if count <= 4 {
        2
    } else if count <= 9 {
        3
    } else {
        4
    };
    let rows = count.div_ceil(columns);

    let total_max_width = request
        .max_width
        .unwrap_or(DEFAULT_MAX_WIDTH)
        .clamp(64, MAX_MAX_WIDTH);
    let border: u32 = 2;
    let header_h: u32 = 6;
    let total_border_w = border * (columns + 1);
    let cell_max_w = ((total_max_width.saturating_sub(total_border_w)) / columns).max(16);

    let mut prepared_frames = Vec::with_capacity(frames.len());
    let mut timestamps_ms = Vec::with_capacity(frames.len());
    let mut region_out = CaptureRegion {
        x: 0.0,
        y: 0.0,
        width: viewport.width.max(1.0),
        height: viewport.height.max(1.0),
    };
    let mut clipped = false;

    for (idx, (ts, png_bytes)) in frames.iter().enumerate() {
        let decoded = image::load_from_memory_with_format(png_bytes, ImageFormat::Png)
            .or_else(|_| image::load_from_memory(png_bytes))
            .map_err(|e| format!("cannot decode screenshot frame {idx}: {e}"))?;
        let (raw_w, raw_h) = decoded.dimensions();
        if raw_w == 0 || raw_h == 0 {
            return Err(format!("screenshot frame {idx} has zero size"));
        }
        let cropped = match region {
            Some(r) => {
                let (img, actual) = crop_to_region(decoded, viewport, r)?;
                if idx == 0 {
                    region_out = actual;
                    clipped = true;
                }
                img
            }
            None => decoded,
        };
        let scaled = scale_down(cropped, cell_max_w);
        prepared_frames.push(scaled.to_rgba8());
        timestamps_ms.push(*ts);
    }

    let cell_w = prepared_frames
        .iter()
        .map(|img| img.width())
        .max()
        .unwrap_or(1)
        .max(1);
    let cell_h = prepared_frames
        .iter()
        .map(|img| img.height())
        .max()
        .unwrap_or(1)
        .max(1);

    let sheet_w = columns * cell_w + (columns + 1) * border;
    let sheet_h = rows * (cell_h + header_h) + (rows + 1) * border;

    let bg_color = image::Rgba([24, 24, 27, 255]);
    let bar_bg_color = image::Rgba([39, 39, 42, 255]);
    let bar_fg_color = image::Rgba([59, 130, 246, 255]);
    let mut canvas = image::RgbaImage::from_pixel(sheet_w, sheet_h, bg_color);

    let denom_ts = over_ms.max(*timestamps_ms.last().unwrap_or(&1)).max(1);

    for (idx, frame_img) in prepared_frames.iter().enumerate() {
        let col = (idx as u32) % columns;
        let row = (idx as u32) / columns;
        let x0 = border + col * (cell_w + border);
        let y0 = border + row * (cell_h + header_h + border);

        let ts = timestamps_ms[idx];
        let progress_w = if count == 1 {
            cell_w
        } else {
            ((u64::from(ts.min(denom_ts)) * u64::from(cell_w)) / u64::from(denom_ts))
                .clamp(2, u64::from(cell_w)) as u32
        };

        for py in 0..header_h {
            for px in 0..cell_w {
                let color = if px < progress_w {
                    bar_fg_color
                } else {
                    bar_bg_color
                };
                canvas.put_pixel(x0 + px, y0 + py, color);
            }
        }

        let img_y0 = y0 + header_h;
        for py in 0..frame_img.height() {
            for px in 0..frame_img.width() {
                canvas.put_pixel(x0 + px, img_y0 + py, *frame_img.get_pixel(px, py));
            }
        }
    }

    let mut bytes = Vec::new();
    DynamicImage::ImageRgba8(canvas)
        .write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
        .map_err(|e| format!("cannot encode contact sheet: {e}"))?;
    let data = base64::engine::general_purpose::STANDARD.encode(&bytes);

    Ok(PageCapture {
        url,
        mime: CaptureFormat::Png.mime().to_string(),
        data,
        width: sheet_w,
        height: sheet_h,
        clipped,
        region: region_out,
        frames_count: Some(count),
        over_ms: Some(over_ms),
        every_ms: Some(every_ms),
        timestamps_ms: Some(timestamps_ms),
        columns: Some(columns),
        rows: Some(rows),
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
    let next_h =
        ((u64::from(h) * u64::from(max_width) + u64::from(w) / 2) / u64::from(w)).max(1) as u32;
    image.resize_exact(max_width, next_h, FilterType::Triangle)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_png(width: u32, height: u32, rgba: [u8; 4]) -> Vec<u8> {
        let img = image::RgbaImage::from_pixel(width, height, image::Rgba(rgba));
        let mut out = Vec::new();
        DynamicImage::ImageRgba8(img)
            .write_to(&mut Cursor::new(&mut out), ImageFormat::Png)
            .expect("encode png");
        out
    }

    #[test]
    fn compose_contact_sheet_builds_grid_and_metadata() {
        let vp = SnapshotViewport {
            width: 200.0,
            height: 100.0,
            dpr: 1.0,
        };
        let frames = vec![
            (0, sample_png(200, 100, [255, 0, 0, 255])),
            (100, sample_png(200, 100, [0, 255, 0, 255])),
            (200, sample_png(200, 100, [0, 0, 255, 255])),
            (300, sample_png(200, 100, [255, 255, 0, 255])),
            (400, sample_png(200, 100, [255, 0, 255, 255])),
        ];
        let req = CaptureRequest {
            max_width: Some(600),
            over_ms: Some(400),
            every_ms: Some(100),
            ..Default::default()
        };
        let sheet = compose_contact_sheet(
            &frames,
            "https://example.test/".to_string(),
            &vp,
            None,
            &req,
            400,
            100,
        )
        .expect("compose contact sheet");

        assert_eq!(sheet.frames_count, Some(5));
        assert_eq!(sheet.columns, Some(3));
        assert_eq!(sheet.rows, Some(2));
        assert_eq!(sheet.over_ms, Some(400));
        assert_eq!(sheet.every_ms, Some(100));
        assert_eq!(sheet.timestamps_ms, Some(vec![0, 100, 200, 300, 400]));
        assert!(sheet.width <= 600);
        assert!(sheet.height > 100);
        assert!(!sheet.data.is_empty());
    }
}
