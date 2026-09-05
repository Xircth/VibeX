use tauri::image::Image;

#[cfg(any(target_os = "windows", test))]
const WINDOWS_CAPTION_PAD: u32 = 4;

#[cfg(target_os = "windows")]
pub(crate) fn windows_caption_icon(bytes: &[u8]) -> Result<Image<'static>, String> {
    let source = Image::from_bytes(bytes).map_err(|error| error.to_string())?;
    Ok(fit_opaque_content(
        source.rgba(),
        source.width(),
        source.height(),
        32,
        WINDOWS_CAPTION_PAD,
    ))
}

pub(crate) fn icon_from_png_bytes(bytes: &[u8]) -> Result<Image<'static>, String> {
    #[cfg(target_os = "windows")]
    {
        windows_caption_icon(bytes)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Image::from_bytes(bytes)
            .map(|icon| icon.to_owned())
            .map_err(|error| error.to_string())
    }
}

#[cfg(any(target_os = "windows", test))]
pub(crate) fn fit_opaque_content(
    rgba: &[u8],
    width: u32,
    height: u32,
    out: u32,
    pad: u32,
) -> Image<'static> {
    let (min_x, min_y, max_x, max_y) = opaque_bbox(rgba, width, height).unwrap_or((
        0,
        0,
        width.saturating_sub(1),
        height.saturating_sub(1),
    ));
    let src_w = (max_x - min_x + 1).max(1);
    let src_h = (max_y - min_y + 1).max(1);
    let inner = out.saturating_sub(pad.saturating_mul(2)).max(1);
    let scale = (inner as f32 / src_w as f32).min(inner as f32 / src_h as f32);
    let dst_w = ((src_w as f32) * scale).round().max(1.0) as u32;
    let dst_h = ((src_h as f32) * scale).round().max(1.0) as u32;
    let origin_x = pad + (inner.saturating_sub(dst_w)) / 2;
    let origin_y = pad + (inner.saturating_sub(dst_h)) / 2;

    let mut out_buf = vec![0u8; (out as usize) * (out as usize) * 4];
    for y in 0..dst_h {
        for x in 0..dst_w {
            let src_x = min_x as f32 + (x as f32 + 0.5) * (src_w as f32) / (dst_w as f32) - 0.5;
            let src_y = min_y as f32 + (y as f32 + 0.5) * (src_h as f32) / (dst_h as f32) - 0.5;
            let sample = sample_bilinear(rgba, width, height, src_x, src_y);
            let dx = (origin_x + x) as usize;
            let dy = (origin_y + y) as usize;
            if dx >= out as usize || dy >= out as usize {
                continue;
            }
            let index = (dy * out as usize + dx) * 4;
            out_buf[index..index + 4].copy_from_slice(&sample);
        }
    }
    Image::new_owned(out_buf, out, out)
}

#[cfg(any(target_os = "windows", test))]
fn opaque_bbox(rgba: &[u8], width: u32, height: u32) -> Option<(u32, u32, u32, u32)> {
    let mut min_x = width;
    let mut min_y = height;
    let mut max_x = 0;
    let mut max_y = 0;
    let mut found = false;
    for y in 0..height {
        for x in 0..width {
            let alpha = rgba[((y * width + x) * 4 + 3) as usize];
            if alpha <= 16 {
                continue;
            }
            found = true;
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
        }
    }
    found.then_some((min_x, min_y, max_x, max_y))
}

#[cfg(any(target_os = "windows", test))]
fn sample_bilinear(rgba: &[u8], width: u32, height: u32, x: f32, y: f32) -> [u8; 4] {
    if width == 0 || height == 0 {
        return [0; 4];
    }
    let max_x = (width - 1) as f32;
    let max_y = (height - 1) as f32;
    let x = x.clamp(0.0, max_x);
    let y = y.clamp(0.0, max_y);
    let x0 = x.floor() as u32;
    let y0 = y.floor() as u32;
    let x1 = (x0 + 1).min(width - 1);
    let y1 = (y0 + 1).min(height - 1);
    let tx = x - x0 as f32;
    let ty = y - y0 as f32;
    let p00 = pixel(rgba, width, x0, y0);
    let p10 = pixel(rgba, width, x1, y0);
    let p01 = pixel(rgba, width, x0, y1);
    let p11 = pixel(rgba, width, x1, y1);
    let mut out = [0u8; 4];
    for channel in 0..4 {
        let top = p00[channel] as f32 * (1.0 - tx) + p10[channel] as f32 * tx;
        let bottom = p01[channel] as f32 * (1.0 - tx) + p11[channel] as f32 * tx;
        out[channel] = (top * (1.0 - ty) + bottom * ty).round().clamp(0.0, 255.0) as u8;
    }
    out
}

#[cfg(any(target_os = "windows", test))]
fn pixel(rgba: &[u8], width: u32, x: u32, y: u32) -> [u8; 4] {
    let index = ((y * width + x) * 4) as usize;
    [
        rgba[index],
        rgba[index + 1],
        rgba[index + 2],
        rgba[index + 3],
    ]
}

#[cfg(test)]
mod tests {
    use super::{WINDOWS_CAPTION_PAD, fit_opaque_content, pixel};

    #[test]
    fn full_bleed_mark_keeps_caption_margin() {
        let width = 8u32;
        let height = 8u32;
        let mut rgba = vec![0u8; (width * height * 4) as usize];
        for px in rgba.chunks_mut(4) {
            px.copy_from_slice(&[220, 40, 40, 255]);
        }

        let icon = fit_opaque_content(&rgba, width, height, 32, WINDOWS_CAPTION_PAD);
        assert_eq!(icon.width(), 32);
        assert_eq!(icon.height(), 32);
        let out = icon.rgba();

        for offset in 0..WINDOWS_CAPTION_PAD {
            assert_eq!(pixel(out, 32, offset, 16)[3], 0, "left pad {offset}");
            assert_eq!(pixel(out, 32, 31 - offset, 16)[3], 0, "right pad {offset}");
            assert_eq!(pixel(out, 32, 16, offset)[3], 0, "top pad {offset}");
            assert_eq!(pixel(out, 32, 16, 31 - offset)[3], 0, "bottom pad {offset}");
        }

        let center = pixel(out, 32, 16, 16);
        assert_eq!(center[3], 255);
        assert!(center[0] > 200);
    }
}
