//! Owned popup host for CEF on Windows.
//!
//! WebView2 composites with DirectComposition over the entire Tauri client
//! area. A Chromium *child* of that HWND is painted and hit-tested by DWM as
//! if it were under the WebView: pages appear frozen, GPU process crashes
//! (`0x80000003`) fall back to in-process software compositing, and the UI
//! thread stops pumping until Windows reports the app hung.
//!
//! The page surface is therefore a `WS_POPUP` owned by the Tauri window, not
//! a sibling of WebView2. Owned popups sit above the owner, receive input,
//! and keep GPU work in CEF's own process.

use std::{cell::RefCell, collections::HashSet, sync::OnceLock};

use browser_runtime::BrowserSurface;
use cef::Rect;
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM},
    Graphics::Gdi::{ClientToScreen, CreateSolidBrush},
    System::LibraryLoader::GetModuleHandleW,
    UI::WindowsAndMessaging::{
        CS_HREDRAW, CS_VREDRAW, CreateWindowExW, DefWindowProcW, DestroyWindow, GW_CHILD,
        GWLP_USERDATA, GetClassNameW, GetParent, GetWindow, GetWindowLongPtrW, HWND_TOP, IDC_ARROW,
        IsIconic, IsWindow, IsWindowVisible, LoadCursorW, RegisterClassW, SW_HIDE,
        SW_SHOWNOACTIVATE, SWP_NOACTIVATE, SWP_NOZORDER, SetWindowLongPtrW, SetWindowPos,
        ShowWindow, WM_NCDESTROY, WNDCLASSW, WS_CLIPCHILDREN, WS_CLIPSIBLINGS, WS_EX_TOOLWINDOW,
        WS_POPUP,
    },
};

use super::native::surface_rect;

pub(crate) const OVERLAY_CLASS: &str = "VibeXBrowserHost";
pub(crate) const OVERLAY_STYLE: u32 = WS_POPUP | WS_CLIPCHILDREN | WS_CLIPSIBLINGS;
pub(crate) const OVERLAY_EX_STYLE: u32 = WS_EX_TOOLWINDOW;
// COLORREF is 0x00BBGGRR for DESIGN.md #fafbfc.
const OVERLAY_BACKGROUND: u32 = 0x00FC_FBFA;

thread_local! {
    static HOSTS: RefCell<HashSet<usize>> = RefCell::new(HashSet::new());
}

struct OverlayState {
    owner: usize,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    visible: bool,
}

pub(crate) fn overlay_child_rect(surface: &BrowserSurface) -> Rect {
    let scaled = surface_rect(surface);
    Rect {
        x: 0,
        y: 0,
        width: scaled.width,
        height: scaled.height,
    }
}

pub(crate) fn create_overlay_host(owner: usize, surface: &BrowserSurface) -> Result<usize, String> {
    register_class()?;
    let owner_hwnd = owner as HWND;
    if owner_hwnd.is_null() || unsafe { IsWindow(owner_hwnd) } == 0 {
        return Err("native browser owner window is invalid".to_string());
    }
    let rect = surface_rect(surface);
    let class = class_wide();
    let hwnd = unsafe {
        CreateWindowExW(
            OVERLAY_EX_STYLE,
            class.as_ptr(),
            std::ptr::null(),
            OVERLAY_STYLE,
            0,
            0,
            rect.width.max(1),
            rect.height.max(1),
            owner_hwnd,
            std::ptr::null_mut(),
            GetModuleHandleW(std::ptr::null()),
            std::ptr::null(),
        )
    };
    if hwnd.is_null() {
        return Err("failed to create the Chromium host window".to_string());
    }
    let state = Box::into_raw(Box::new(OverlayState {
        owner,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        visible: surface.visible,
    }));
    unsafe {
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, state as isize);
    }
    HOSTS.with(|hosts| {
        hosts.borrow_mut().insert(hwnd as usize);
    });
    unsafe {
        position_overlay(hwnd, &*state);
    }
    Ok(hwnd as usize)
}

pub(crate) fn destroy_overlay_hwnd(hwnd: usize) {
    let hwnd = hwnd as HWND;
    if hwnd.is_null() || unsafe { IsWindow(hwnd) } == 0 {
        return;
    }
    unsafe {
        DestroyWindow(hwnd);
    }
}

pub(crate) fn sync_overlay_hosts() {
    let hosts: Vec<usize> = HOSTS.with(|hosts| hosts.borrow().iter().copied().collect());
    for hwnd in hosts {
        let hwnd = hwnd as HWND;
        if hwnd.is_null() || unsafe { IsWindow(hwnd) } == 0 {
            continue;
        }
        let ptr = unsafe { GetWindowLongPtrW(hwnd, GWLP_USERDATA) };
        if ptr == 0 {
            continue;
        }
        unsafe {
            let state = &mut *(ptr as *mut OverlayState);
            position_overlay(hwnd, state);
            fill_child(hwnd, state.width, state.height);
        }
    }
}

pub(crate) fn apply_overlay_surface(
    browser_hwnd: usize,
    surface: &BrowserSurface,
) -> Result<(), String> {
    let overlay = overlay_for_browser(browser_hwnd as HWND)
        .ok_or_else(|| "browser overlay host is missing".to_string())?;
    let rect = surface_rect(surface);
    let ptr = unsafe { GetWindowLongPtrW(overlay, GWLP_USERDATA) };
    if ptr == 0 {
        return Err("browser overlay host state is missing".to_string());
    }
    unsafe {
        let state = &mut *(ptr as *mut OverlayState);
        state.x = rect.x;
        state.y = rect.y;
        state.width = rect.width;
        state.height = rect.height;
        state.visible = surface.visible;
        position_overlay(overlay, state);
        fill_child(overlay, state.width, state.height);
    }
    Ok(())
}

pub(crate) fn hide_overlay_for_browser(browser_hwnd: usize) -> Result<(), String> {
    let Some(overlay) = overlay_for_browser(browser_hwnd as HWND) else {
        return Ok(());
    };
    let ptr = unsafe { GetWindowLongPtrW(overlay, GWLP_USERDATA) };
    if ptr != 0 {
        unsafe {
            (*(ptr as *mut OverlayState)).visible = false;
        }
    }
    unsafe {
        ShowWindow(overlay, SW_HIDE);
    }
    Ok(())
}

pub(crate) fn destroy_overlay_for_browser(browser_hwnd: usize) -> Result<(), String> {
    if let Some(overlay) = overlay_for_browser(browser_hwnd as HWND) {
        destroy_overlay_hwnd(overlay as usize);
    }
    Ok(())
}

fn overlay_for_browser(browser_hwnd: HWND) -> Option<HWND> {
    if browser_hwnd.is_null() {
        return None;
    }
    if is_overlay(browser_hwnd) {
        return Some(browser_hwnd);
    }
    let parent = unsafe { GetParent(browser_hwnd) };
    if is_overlay(parent) {
        Some(parent)
    } else {
        None
    }
}

fn is_overlay(hwnd: HWND) -> bool {
    if hwnd.is_null() {
        return false;
    }
    let mut buf = [0u16; 64];
    let length = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    if length <= 0 {
        return false;
    }
    let class = String::from_utf16_lossy(&buf[..length as usize]);
    class == OVERLAY_CLASS
}

fn class_wide() -> &'static [u16] {
    static NAME: OnceLock<Vec<u16>> = OnceLock::new();
    NAME.get_or_init(|| {
        OVERLAY_CLASS
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect()
    })
}

fn register_class() -> Result<(), String> {
    static REGISTERED: OnceLock<Result<(), String>> = OnceLock::new();
    match REGISTERED.get_or_init(|| {
        let class = class_wide();
        let wnd = WNDCLASSW {
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(overlay_wnd_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: unsafe { GetModuleHandleW(std::ptr::null()) },
            hIcon: std::ptr::null_mut(),
            hCursor: unsafe { LoadCursorW(std::ptr::null_mut(), IDC_ARROW) },
            hbrBackground: unsafe { CreateSolidBrush(OVERLAY_BACKGROUND) },
            lpszMenuName: std::ptr::null(),
            lpszClassName: class.as_ptr(),
        };
        if unsafe { RegisterClassW(&wnd) } == 0 {
            return Err("failed to register the Chromium host window class".to_string());
        }
        Ok(())
    }) {
        Ok(()) => Ok(()),
        Err(error) => Err(error.clone()),
    }
}

unsafe fn position_overlay(hwnd: HWND, state: &OverlayState) {
    unsafe {
        let owner = state.owner as HWND;
        if owner.is_null() || IsWindow(owner) == 0 {
            ShowWindow(hwnd, SW_HIDE);
            return;
        }
        if !state.visible || IsIconic(owner) != 0 || IsWindowVisible(owner) == 0 {
            ShowWindow(hwnd, SW_HIDE);
            return;
        }
        let mut origin = POINT {
            x: state.x,
            y: state.y,
        };
        if ClientToScreen(owner, &mut origin) == 0 {
            return;
        }
        SetWindowPos(
            hwnd,
            HWND_TOP,
            origin.x,
            origin.y,
            state.width.max(1),
            state.height.max(1),
            SWP_NOACTIVATE,
        );
        ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    }
}

unsafe fn fill_child(overlay: HWND, width: i32, height: i32) {
    unsafe {
        let child = GetWindow(overlay, GW_CHILD);
        if child.is_null() {
            return;
        }
        SetWindowPos(
            child,
            std::ptr::null_mut(),
            0,
            0,
            width.max(1),
            height.max(1),
            SWP_NOACTIVATE | SWP_NOZORDER,
        );
    }
}

unsafe extern "system" fn overlay_wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    unsafe {
        if msg == WM_NCDESTROY {
            let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            if ptr != 0 {
                drop(Box::from_raw(ptr as *mut OverlayState));
            }
            HOSTS.with(|hosts| {
                hosts.borrow_mut().remove(&(hwnd as usize));
            });
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }
}

#[cfg(test)]
mod tests {
    use browser_runtime::BrowserSurface;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS, WS_EX_TOOLWINDOW, WS_POPUP,
    };

    use super::{OVERLAY_EX_STYLE, OVERLAY_STYLE, overlay_child_rect};

    fn surface() -> BrowserSurface {
        BrowserSurface {
            x: 24,
            y: 80,
            width: 800,
            height: 600,
            scale_factor: 1.5,
            visible: true,
        }
    }

    #[test]
    fn host_is_an_owned_popup_not_a_webview2_child() {
        assert_eq!(OVERLAY_STYLE & WS_POPUP, WS_POPUP);
        assert_eq!(OVERLAY_STYLE & WS_CHILD, 0);
        assert_eq!(OVERLAY_STYLE & WS_CLIPCHILDREN, WS_CLIPCHILDREN);
        assert_eq!(OVERLAY_STYLE & WS_CLIPSIBLINGS, WS_CLIPSIBLINGS);
        assert_eq!(OVERLAY_EX_STYLE, WS_EX_TOOLWINDOW);
    }

    #[test]
    fn chromium_child_fills_the_overlay_origin() {
        let rect = overlay_child_rect(&surface());
        assert_eq!(rect.x, 0);
        assert_eq!(rect.y, 0);
        assert_eq!(rect.width, 1200);
        assert_eq!(rect.height, 900);
    }
}
