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

#[cfg(target_os = "macos")]
fn macos_origin_y(css_y: f64, height: f64, parent_height: f64, is_flipped: bool) -> f64 {
    if is_flipped {
        css_y
    } else {
        parent_height - css_y - height
    }
}

#[cfg(target_os = "macos")]
fn macos_safe_area_origin_y(
    css_y: f64,
    height: f64,
    parent_height: f64,
    is_flipped: bool,
    safe_area_top: f64,
) -> f64 {
    macos_origin_y(css_y + safe_area_top, height, parent_height, is_flipped)
}

#[cfg(all(test, target_os = "macos"))]
mod macos_tests {
    use super::{macos_origin_y, macos_safe_area_origin_y};

    #[test]
    fn preserves_css_y_for_flipped_parent_views() {
        assert_eq!(macos_origin_y(120.0, 300.0, 900.0, true), 120.0);
    }

    #[test]
    fn converts_css_y_for_bottom_left_parent_views() {
        assert_eq!(macos_origin_y(120.0, 300.0, 900.0, false), 480.0);
    }

    #[test]
    fn offsets_css_coordinates_below_the_macos_safe_area() {
        assert_eq!(
            macos_safe_area_origin_y(120.0, 300.0, 900.0, true, 28.0),
            148.0
        );
        assert_eq!(
            macos_safe_area_origin_y(120.0, 300.0, 900.0, false, 28.0),
            452.0
        );
    }
}

#[cfg(target_os = "macos")]
pub fn parent_handle(raw: usize) -> cef::sys::cef_window_handle_t {
    raw as *mut std::ffi::c_void
}

#[cfg(target_os = "windows")]
pub fn parent_handle(raw: usize) -> cef::sys::cef_window_handle_t {
    cef::sys::HWND(raw as *mut _)
}

#[cfg(target_os = "linux")]
pub fn parent_handle(raw: usize) -> cef::sys::cef_window_handle_t {
    raw as _
}

#[cfg(target_os = "linux")]
fn shared_xlib() -> Result<&'static x11_dl::xlib::Xlib, String> {
    use std::sync::OnceLock;

    use x11_dl::xlib;

    static XLIB: OnceLock<Result<xlib::Xlib, String>> = OnceLock::new();
    match XLIB.get_or_init(|| xlib::Xlib::open().map_err(|error| error.to_string())) {
        Ok(xlib) => Ok(xlib),
        Err(error) => Err(error.clone()),
    }
}

#[cfg(target_os = "macos")]
pub fn apply_surface(browser: &Browser, surface: &BrowserSurface) -> Result<(), String> {
    use objc2::{
        msg_send,
        runtime::{AnyObject, Bool},
    };
    use objc2_foundation::{NSEdgeInsets, NSPoint, NSRect, NSSize};

    let host = browser
        .host()
        .ok_or_else(|| "browser host is missing".to_string())?;
    let handle = host.window_handle();
    if handle.is_null() {
        return Err("browser native view is missing".to_string());
    }
    let view = unsafe { &*handle.cast::<AnyObject>() };
    let superview: *mut AnyObject = unsafe { msg_send![view, superview] };
    if superview.is_null() {
        return Err("browser native parent view is missing".to_string());
    }
    let superview = unsafe { &*superview };
    let parent_is_flipped: Bool = unsafe { msg_send![superview, isFlipped] };
    let parent_bounds: NSRect = unsafe { msg_send![superview, bounds] };
    let safe_area: NSEdgeInsets = unsafe { msg_send![superview, safeAreaInsets] };
    let height = f64::from(surface.height);
    let frame = NSRect::new(
        NSPoint::new(
            f64::from(surface.x),
            macos_safe_area_origin_y(
                f64::from(surface.y),
                height,
                parent_bounds.size.height,
                parent_is_flipped.as_bool(),
                safe_area.top,
            ),
        ),
        NSSize::new(f64::from(surface.width), height),
    );
    unsafe {
        let _: () = msg_send![view, setFrame: frame];
        let _: () = msg_send![view, setHidden: Bool::new(!surface.visible)];
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn hide_browser_view(browser: &Browser) -> Result<(), String> {
    use objc2::{
        msg_send,
        runtime::{AnyObject, Bool},
    };

    let host = browser
        .host()
        .ok_or_else(|| "browser host is missing".to_string())?;
    let handle = host.window_handle();
    if handle.is_null() {
        return Err("browser native view is missing".to_string());
    }
    let view = unsafe { &*handle.cast::<AnyObject>() };
    unsafe {
        let _: () = msg_send![view, setHidden: Bool::new(true)];
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn destroy_browser_view(browser: &Browser) -> Result<(), String> {
    use objc2::{msg_send, runtime::AnyObject};

    let host = browser
        .host()
        .ok_or_else(|| "browser host is missing".to_string())?;
    let handle = host.window_handle();
    if handle.is_null() {
        return Err("browser native view is missing".to_string());
    }
    let view = unsafe { &*handle.cast::<AnyObject>() };
    unsafe {
        let _: () = msg_send![view, removeFromSuperview];
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
    let handle = host.window_handle().0.cast::<std::ffi::c_void>();
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

#[cfg(target_os = "windows")]
pub fn hide_browser_view(browser: &Browser) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SW_HIDE, ShowWindow};

    let host = browser
        .host()
        .ok_or_else(|| "browser host is missing".to_string())?;
    let handle = host.window_handle().0.cast::<std::ffi::c_void>();
    if handle.is_null() {
        return Err("browser native window is missing".to_string());
    }
    unsafe {
        ShowWindow(handle, SW_HIDE);
    }
    Ok(())
}

#[cfg(target_os = "windows")]
pub fn destroy_browser_view(browser: &Browser) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::DestroyWindow;

    let host = browser
        .host()
        .ok_or_else(|| "browser host is missing".to_string())?;
    let handle = host.window_handle().0.cast::<std::ffi::c_void>();
    if handle.is_null() {
        return Err("browser native window is missing".to_string());
    }
    if unsafe { DestroyWindow(handle) } == 0 {
        return Err("DestroyWindow failed".to_string());
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn apply_surface(browser: &Browser, surface: &BrowserSurface) -> Result<(), String> {
    let xlib = shared_xlib()?;
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

#[cfg(target_os = "linux")]
pub fn hide_browser_view(browser: &Browser) -> Result<(), String> {
    let xlib = shared_xlib()?;
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
    unsafe {
        (xlib.XUnmapWindow)(display, handle);
        (xlib.XFlush)(display);
        (xlib.XCloseDisplay)(display);
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn destroy_browser_view(browser: &Browser) -> Result<(), String> {
    let xlib = shared_xlib()?;
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
    unsafe {
        (xlib.XDestroyWindow)(display, handle);
        (xlib.XFlush)(display);
        (xlib.XCloseDisplay)(display);
    }
    Ok(())
}
