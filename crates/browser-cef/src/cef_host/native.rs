use browser_runtime::BrowserSurface;
use cef::{Browser, ImplBrowser, ImplBrowserHost, Rect};

pub fn surface_rect(surface: &BrowserSurface) -> Rect {
    let scale = if cfg!(target_os = "macos") {
        1.0
    } else {
        surface.scale_factor
    };
    Rect {
        x: scaled_i32(surface.x, scale),
        y: scaled_i32(surface.y, scale),
        width: scaled_u32(surface.width, scale),
        height: scaled_u32(surface.height, scale),
    }
}

fn scaled_i32(value: i32, scale: f64) -> i32 {
    (f64::from(value) * scale)
        .round()
        .clamp(f64::from(i32::MIN), f64::from(i32::MAX)) as i32
}

fn scaled_u32(value: u32, scale: f64) -> i32 {
    (f64::from(value) * scale)
        .round()
        .clamp(0.0, f64::from(i32::MAX)) as i32
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub fn parent_handle(raw: usize) -> cef::sys::cef_window_handle_t {
    raw as *mut std::ffi::c_void
}

#[cfg(target_os = "linux")]
pub fn parent_handle(raw: usize) -> cef::sys::cef_window_handle_t {
    raw as _
}

#[cfg(target_os = "macos")]
pub fn apply_surface(browser: &Browser, surface: &BrowserSurface) -> Result<(), String> {
    use objc2::{
        msg_send,
        runtime::{AnyObject, Bool},
    };
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    let host = browser
        .host()
        .ok_or_else(|| "browser host is missing".to_string())?;
    let handle = host.window_handle();
    if handle.is_null() {
        return Err("browser native view is missing".to_string());
    }
    let view = unsafe { &*handle.cast::<AnyObject>() };
    let frame = NSRect::new(
        NSPoint::new(f64::from(surface.x), f64::from(surface.y)),
        NSSize::new(f64::from(surface.width), f64::from(surface.height)),
    );
    unsafe {
        let _: () = msg_send![view, setFrame: frame];
        let _: () = msg_send![view, setHidden: Bool::new(!surface.visible)];
    }
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn apply_surface(browser: &Browser, surface: &BrowserSurface) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SW_HIDE, SW_SHOW, SWP_NOACTIVATE, SWP_NOZORDER, SetWindowPos, ShowWindow,
    };

    let host = browser
        .host()
        .ok_or_else(|| "browser host is missing".to_string())?;
    let handle = host.window_handle();
    if handle.is_null() {
        return Err("browser native window is missing".to_string());
    }
    let rect = surface_rect(surface);
    unsafe {
        if SetWindowPos(
            handle,
            std::ptr::null_mut(),
            rect.x,
            rect.y,
            rect.width,
            rect.height,
            SWP_NOACTIVATE | SWP_NOZORDER,
        ) == 0
        {
            return Err("SetWindowPos failed".to_string());
        }
        ShowWindow(handle, if surface.visible { SW_SHOW } else { SW_HIDE });
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn apply_surface(browser: &Browser, surface: &BrowserSurface) -> Result<(), String> {
    use std::sync::OnceLock;

    use x11_dl::xlib;

    static XLIB: OnceLock<xlib::Xlib> = OnceLock::new();
    let xlib = XLIB.get_or_try_init(|| xlib::Xlib::open().map_err(|error| error.to_string()))?;
    let host = browser
        .host()
        .ok_or_else(|| "browser host is missing".to_string())?;
    let handle = host.window_handle();
    if handle == 0 {
        return Err("browser native window is missing".to_string());
    }
    let display = unsafe { (xlib.XOpenDisplay)(std::ptr::null()) };
    if display.is_null() {
        return Err("X11 display is unavailable".to_string());
    }
    let rect = surface_rect(surface);
    unsafe {
        (xlib.XMoveResizeWindow)(
            display,
            handle,
            rect.x,
            rect.y,
            rect.width.max(1) as u32,
            rect.height.max(1) as u32,
        );
        if surface.visible {
            (xlib.XMapWindow)(display, handle);
        } else {
            (xlib.XUnmapWindow)(display, handle);
        }
        (xlib.XFlush)(display);
        (xlib.XCloseDisplay)(display);
    }
    Ok(())
}
