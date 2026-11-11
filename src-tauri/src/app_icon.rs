use tauri::image::Image;

#[cfg(any(target_os = "windows", test))]
const WINDOWS_CAPTION_SIZE: u32 = 32;
// 2px pad on a 32px slot is ~85% glyph fill (was 4px → ~75% / 70-relative).
#[cfg(any(target_os = "windows", test))]
const WINDOWS_CAPTION_PAD: u32 = 2;
#[cfg(target_os = "windows")]
const WINDOWS_TASKBAR_SIZE: u32 = 256;
#[cfg(target_os = "windows")]
const WINDOWS_TASKBAR_PAD: u32 = 0;

#[cfg(target_os = "windows")]
pub(crate) fn windows_caption_icon(bytes: &[u8]) -> Result<Image<'static>, String> {
    let source = Image::from_bytes(bytes).map_err(|error| error.to_string())?;
    Ok(fit_opaque_content(
        source.rgba(),
        source.width(),
        source.height(),
        WINDOWS_CAPTION_SIZE,
        WINDOWS_CAPTION_PAD,
    ))
}

#[cfg(target_os = "windows")]
const PKEY_APPUSERMODEL_ID: windows::Win32::Foundation::PROPERTYKEY =
    windows::Win32::Foundation::PROPERTYKEY {
        fmtid: windows::core::GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
        pid: 5,
    };

#[cfg(target_os = "windows")]
const PKEY_APPUSERMODEL_RELAUNCH_COMMAND: windows::Win32::Foundation::PROPERTYKEY =
    windows::Win32::Foundation::PROPERTYKEY {
        fmtid: windows::core::GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
        pid: 2,
    };

#[cfg(target_os = "windows")]
const PKEY_APPUSERMODEL_RELAUNCH_ICON_RESOURCE: windows::Win32::Foundation::PROPERTYKEY =
    windows::Win32::Foundation::PROPERTYKEY {
        fmtid: windows::core::GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
        pid: 3,
    };

#[cfg(target_os = "windows")]
const PKEY_APPUSERMODEL_RELAUNCH_DISPLAY_NAME_RESOURCE: windows::Win32::Foundation::PROPERTYKEY =
    windows::Win32::Foundation::PROPERTYKEY {
        fmtid: windows::core::GUID::from_u128(0x9f4c2855_9f79_4b39_a8d0_e1d42de1d5f3),
        pid: 4,
    };

#[cfg(target_os = "windows")]
fn write_single_png_ico(png_bytes: &[u8]) -> Result<std::path::PathBuf, String> {
    use sha2::{Digest, Sha256};

    let digest = Sha256::digest(png_bytes);
    let mut hash_hex = String::with_capacity(16);
    for byte in &digest[..8] {
        use std::fmt::Write;
        let _ = write!(&mut hash_hex, "{byte:02x}");
    }

    let dir = utils::assets::asset_dir().join("taskbar-icons");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let ico_path = dir.join(format!("app-icon-{hash_hex}.ico"));
    if !ico_path.is_file() {
        let len = png_bytes.len() as u32;
        let mut ico = Vec::with_capacity(22 + png_bytes.len());
        // ICONDIR: Reserved=0, Type=1 (ICO), Count=1
        ico.extend_from_slice(&0u16.to_le_bytes());
        ico.extend_from_slice(&1u16.to_le_bytes());
        ico.extend_from_slice(&1u16.to_le_bytes());
        // ICONDIRENTRY: 256x256 (0, 0), ColorCount=0, Reserved=0, Planes=1, BitCount=32, BytesInRes, ImageOffset=22
        ico.push(0);
        ico.push(0);
        ico.push(0);
        ico.push(0);
        ico.extend_from_slice(&1u16.to_le_bytes());
        ico.extend_from_slice(&32u16.to_le_bytes());
        ico.extend_from_slice(&len.to_le_bytes());
        ico.extend_from_slice(&22u32.to_le_bytes());
        ico.extend_from_slice(png_bytes);
        std::fs::write(&ico_path, ico).map_err(|error| error.to_string())?;
    }
    Ok(ico_path)
}

#[cfg(target_os = "windows")]
pub(crate) fn apply_windows_taskbar_icon(
    window: &tauri::WebviewWindow,
    bytes: &[u8],
) -> Result<(), String> {
    use tauri::Manager;
    use windows::Win32::{
        Foundation::{LPARAM, WPARAM},
        System::Com::StructuredStorage::PROPVARIANT,
        UI::{
            Shell::{
                PropertiesSystem::{IPropertyStore, SHGetPropertyStoreForWindow},
                SHCNE_ASSOCCHANGED, SHCNF_IDLIST, SHChangeNotify,
            },
            WindowsAndMessaging::{
                CreateIcon, DestroyIcon, GCLP_HICON, HICON, ICON_BIG, SendMessageW,
                SetClassLongPtrW, WM_SETICON,
            },
        },
    };

    let source = Image::from_bytes(bytes).map_err(|error| error.to_string())?;
    let icon = fit_opaque_content(
        source.rgba(),
        source.width(),
        source.height(),
        WINDOWS_TASKBAR_SIZE,
        WINDOWS_TASKBAR_PAD,
    );
    let width = icon.width();
    let height = icon.height();
    let mut bgra = icon.rgba().to_vec();
    let pixel_count = bgra.len() / 4;
    let mut and_mask = Vec::with_capacity(pixel_count);
    for px in bgra.chunks_exact_mut(4) {
        px.swap(0, 2);
        and_mask.push(px[3].wrapping_sub(u8::MAX));
    }

    let ico_path = write_single_png_ico(bytes)?;
    let icon_resource = format!("{},0", ico_path.display());
    let app_id = format!(
        "{}.{}",
        window.app_handle().config().identifier,
        ico_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("icon")
    );
    let display_name = window
        .app_handle()
        .config()
        .product_name
        .clone()
        .unwrap_or_else(|| "VibeX".to_string());
    let exe_command = std::env::current_exe()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();

    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    unsafe {
        if let Ok(store) = SHGetPropertyStoreForWindow::<IPropertyStore>(hwnd) {
            let _ = store.SetValue(&PKEY_APPUSERMODEL_ID, &PROPVARIANT::from(app_id.as_str()));
            if !exe_command.is_empty() {
                let _ = store.SetValue(
                    &PKEY_APPUSERMODEL_RELAUNCH_COMMAND,
                    &PROPVARIANT::from(exe_command.as_str()),
                );
            }
            let _ = store.SetValue(
                &PKEY_APPUSERMODEL_RELAUNCH_DISPLAY_NAME_RESOURCE,
                &PROPVARIANT::from(display_name.as_str()),
            );
            let _ = store.SetValue(
                &PKEY_APPUSERMODEL_RELAUNCH_ICON_RESOURCE,
                &PROPVARIANT::from(icon_resource.as_str()),
            );
            let _ = store.Commit();
        }

        let hicon = CreateIcon(
            None,
            width as i32,
            height as i32,
            1,
            32,
            and_mask.as_ptr(),
            bgra.as_ptr(),
        )
        .map_err(|error| error.to_string())?;

        let prev = SendMessageW(
            hwnd,
            WM_SETICON,
            Some(WPARAM(ICON_BIG as usize)),
            Some(LPARAM(hicon.0 as isize)),
        );
        SetClassLongPtrW(hwnd, GCLP_HICON, hicon.0 as isize);
        if prev.0 != 0 && prev.0 != hicon.0 as isize {
            let _ = DestroyIcon(HICON(prev.0 as *mut core::ffi::c_void));
        }
        SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_IDLIST, None, None);
    }
    Ok(())
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
    use super::{WINDOWS_CAPTION_PAD, WINDOWS_CAPTION_SIZE, fit_opaque_content, pixel};

    #[test]
    fn full_bleed_mark_keeps_caption_margin() {
        let width = 8u32;
        let height = 8u32;
        let mut rgba = vec![0u8; (width * height * 4) as usize];
        for px in rgba.chunks_mut(4) {
            px.copy_from_slice(&[220, 40, 40, 255]);
        }

        let icon = fit_opaque_content(
            &rgba,
            width,
            height,
            WINDOWS_CAPTION_SIZE,
            WINDOWS_CAPTION_PAD,
        );
        assert_eq!(icon.width(), WINDOWS_CAPTION_SIZE);
        assert_eq!(icon.height(), WINDOWS_CAPTION_SIZE);
        let out = icon.rgba();
        let last = WINDOWS_CAPTION_SIZE - 1;
        let mid = WINDOWS_CAPTION_SIZE / 2;

        for offset in 0..WINDOWS_CAPTION_PAD {
            assert_eq!(
                pixel(out, WINDOWS_CAPTION_SIZE, offset, mid)[3],
                0,
                "left pad {offset}"
            );
            assert_eq!(
                pixel(out, WINDOWS_CAPTION_SIZE, last - offset, mid)[3],
                0,
                "right pad {offset}"
            );
            assert_eq!(
                pixel(out, WINDOWS_CAPTION_SIZE, mid, offset)[3],
                0,
                "top pad {offset}"
            );
            assert_eq!(
                pixel(out, WINDOWS_CAPTION_SIZE, mid, last - offset)[3],
                0,
                "bottom pad {offset}"
            );
        }

        let center = pixel(out, WINDOWS_CAPTION_SIZE, mid, mid);
        assert_eq!(center[3], 255);
        assert!(center[0] > 200);
    }
}
