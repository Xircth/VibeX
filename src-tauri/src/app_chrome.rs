//! Process-wide window chrome: app menu, tray ids, macOS dock, Windows jump list.

use tauri::AppHandle;

use crate::{
    app_windows::open_local_app_window, commands::settings_window::open_local_settings_window,
};

pub const MENU_ID_NEW_WINDOW: &str = "app:new-window";
pub const MENU_ID_OPEN_SETTINGS: &str = "app:open-settings";
pub const LAUNCH_ARG_NEW_WINDOW: &str = "--new-window";
pub const LAUNCH_ARG_OPEN_SETTINGS: &str = "--open-settings";

const LABEL_NEW_WINDOW: &str = "新建窗口";
const LABEL_OPEN_SETTINGS: &str = "打开设置";
const FILE_MENU_TITLE: &str = "文件";
const EDIT_MENU_TITLE: &str = "编辑";
#[cfg(target_os = "macos")]
const VIEW_MENU_TITLE: &str = "显示";
const WINDOW_MENU_TITLE: &str = "窗口";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchAction {
    NewWindow,
    OpenSettings,
}

pub fn launch_action(args: &[String]) -> Option<LaunchAction> {
    if args.iter().any(|arg| arg == LAUNCH_ARG_OPEN_SETTINGS) {
        Some(LaunchAction::OpenSettings)
    } else if args.iter().any(|arg| arg == LAUNCH_ARG_NEW_WINDOW) {
        Some(LaunchAction::NewWindow)
    } else {
        None
    }
}

pub fn handle_menu_event(app: &AppHandle, id: &str) -> bool {
    match id {
        MENU_ID_NEW_WINDOW => {
            if let Err(error) = open_local_app_window(app) {
                tracing::warn!("Failed to open app window: {error}");
            }
            true
        }
        MENU_ID_OPEN_SETTINGS => {
            if let Err(error) = open_local_settings_window(app) {
                tracing::warn!("Failed to open settings: {error}");
            }
            true
        }
        _ => false,
    }
}

pub fn apply_forwarded_launch_args(app: &AppHandle, args: &[String]) -> bool {
    match launch_action(args) {
        Some(LaunchAction::OpenSettings) => {
            if let Err(error) = open_local_settings_window(app) {
                tracing::warn!("Failed to open settings from launch args: {error}");
            }
            true
        }
        Some(LaunchAction::NewWindow) => {
            if let Err(error) = open_local_app_window(app) {
                tracing::warn!("Failed to open app window from launch args: {error}");
            }
            true
        }
        None => false,
    }
}

pub fn apply_startup_args(app: &AppHandle) {
    let args: Vec<String> = std::env::args().collect();
    if launch_action(&args) == Some(LaunchAction::OpenSettings)
        && let Err(error) = open_local_settings_window(app)
    {
        tracing::warn!("Failed to open settings at startup: {error}");
    }
}

pub fn install(app: &AppHandle) {
    if let Err(error) = install_app_menu(app) {
        tracing::warn!("Failed to install app menu: {error}");
    }
    #[cfg(target_os = "macos")]
    if let Err(error) = macos::install_dock_menu() {
        tracing::warn!("Failed to install dock menu: {error}");
    }
    #[cfg(target_os = "windows")]
    if let Err(error) = windows_jumplist::install() {
        tracing::warn!("Failed to install taskbar jump list: {error}");
    }
}

fn install_app_menu(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItem, SubmenuBuilder};

    let new_window = MenuItem::with_id(
        app,
        MENU_ID_NEW_WINDOW,
        LABEL_NEW_WINDOW,
        true,
        None::<&str>,
    )?;
    let open_settings = MenuItem::with_id(
        app,
        MENU_ID_OPEN_SETTINGS,
        LABEL_OPEN_SETTINGS,
        true,
        None::<&str>,
    )?;

    let file_menu = SubmenuBuilder::new(app, FILE_MENU_TITLE)
        .item(&new_window)
        .item(&open_settings)
        .separator()
        .close_window()
        .build()?;
    // WKWebView on macOS delivers Cmd+C/V/X/A/Z through the Edit menu
    // responder chain. Replacing the default menu without these items
    // disables copy and paste in every webview.
    let edit_menu = SubmenuBuilder::new(app, EDIT_MENU_TITLE)
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let window_menu = SubmenuBuilder::new(app, WINDOW_MENU_TITLE)
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;

    #[cfg(target_os = "macos")]
    let menu = {
        let pkg_name = app.package_info().name.clone();
        let app_menu = SubmenuBuilder::new(app, pkg_name)
            .about(None)
            .separator()
            .item(&new_window)
            .item(&open_settings)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .separator()
            .quit()
            .build()?;
        let view_menu = SubmenuBuilder::new(app, VIEW_MENU_TITLE)
            .fullscreen()
            .build()?;
        MenuBuilder::new(app)
            .item(&app_menu)
            .item(&file_menu)
            .item(&edit_menu)
            .item(&view_menu)
            .item(&window_menu)
            .build()?
    };

    #[cfg(not(target_os = "macos"))]
    let menu = MenuBuilder::new(app)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&window_menu)
        .build()?;

    app.set_menu(menu)?;
    Ok(())
}

#[cfg(target_os = "macos")]
mod macos {
    use std::{
        cell::RefCell,
        ffi::c_void,
        sync::atomic::{AtomicPtr, Ordering},
    };

    use muda::ContextMenu;
    use objc2::{
        runtime::{AnyObject, Sel},
        sel,
    };
    use objc2_app_kit::NSApplication;
    use objc2_foundation::MainThreadMarker;

    use super::{LABEL_NEW_WINDOW, LABEL_OPEN_SETTINGS, MENU_ID_NEW_WINDOW, MENU_ID_OPEN_SETTINGS};

    thread_local! {
        static DOCK_MENU: RefCell<Option<muda::Menu>> = const { RefCell::new(None) };
    }

    static DOCK_NSMENU: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

    unsafe extern "C-unwind" fn application_dock_menu(
        _this: *mut AnyObject,
        _cmd: Sel,
        _sender: *mut AnyObject,
    ) -> *mut AnyObject {
        DOCK_NSMENU.load(Ordering::SeqCst) as *mut AnyObject
    }

    pub fn install_dock_menu() -> Result<(), String> {
        let new_window = muda::MenuItem::with_id(MENU_ID_NEW_WINDOW, LABEL_NEW_WINDOW, true, None);
        let open_settings =
            muda::MenuItem::with_id(MENU_ID_OPEN_SETTINGS, LABEL_OPEN_SETTINGS, true, None);
        let menu = muda::Menu::with_items(&[&new_window, &open_settings])
            .map_err(|error| error.to_string())?;
        let ns_menu = menu.ns_menu();
        DOCK_NSMENU.store(ns_menu, Ordering::SeqCst);
        DOCK_MENU.with(|slot| {
            *slot.borrow_mut() = Some(menu);
        });
        unsafe { hook_application_dock_menu() };
        Ok(())
    }

    unsafe fn hook_application_dock_menu() {
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let app = NSApplication::sharedApplication(mtm);
        let Some(delegate) = app.delegate() else {
            return;
        };
        let obj: &AnyObject = delegate.as_ref();
        let class = obj.class();
        let types = c"@@:@";
        unsafe {
            let _ = objc2::ffi::class_addMethod(
                class as *const _ as *mut _,
                sel!(applicationDockMenu:),
                std::mem::transmute::<
                    unsafe extern "C-unwind" fn(
                        *mut AnyObject,
                        Sel,
                        *mut AnyObject,
                    ) -> *mut AnyObject,
                    objc2::runtime::Imp,
                >(application_dock_menu),
                types.as_ptr(),
            );
        }
    }
}

#[cfg(target_os = "windows")]
mod windows_jumplist {
    use super::{
        LABEL_NEW_WINDOW, LABEL_OPEN_SETTINGS, LAUNCH_ARG_NEW_WINDOW, LAUNCH_ARG_OPEN_SETTINGS,
    };

    pub fn install() -> windows::core::Result<()> {
        use windows::{
            Win32::{
                System::Com::{
                    CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance,
                    CoInitializeEx,
                },
                UI::Shell::{
                    Common::{IObjectArray, IObjectCollection},
                    DestinationList, EnumerableObjectCollection, ICustomDestinationList,
                    IShellLinkW, ShellLink,
                },
            },
            core::Interface,
        };

        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let dest: ICustomDestinationList =
                CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
            dest.SetAppID(windows::core::w!("com.vibex.app"))?;
            let mut min_slots = 0u32;
            let _removed: IObjectArray = dest.BeginList(&mut min_slots)?;

            let tasks: IObjectCollection =
                CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
            let exe = std::env::current_exe().unwrap_or_default();
            tasks.AddObject(&shell_link(&exe, LAUNCH_ARG_NEW_WINDOW, LABEL_NEW_WINDOW)?)?;
            tasks.AddObject(&shell_link(
                &exe,
                LAUNCH_ARG_OPEN_SETTINGS,
                LABEL_OPEN_SETTINGS,
            )?)?;
            let tasks_array: IObjectArray = tasks.cast()?;
            dest.AddUserTasks(&tasks_array)?;
            dest.CommitList()?;
        }
        Ok(())
    }

    fn shell_link(
        exe: &std::path::Path,
        args: &str,
        title: &str,
    ) -> windows::core::Result<windows::Win32::UI::Shell::IShellLinkW> {
        use windows::{
            Win32::{
                System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance},
                UI::Shell::{IShellLinkW, ShellLink},
            },
            core::Interface,
        };

        unsafe {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            let exe_wide: Vec<u16> = exe
                .to_string_lossy()
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            link.SetPath(windows::core::PCWSTR(exe_wide.as_ptr()))?;
            let args_wide: Vec<u16> = args.encode_utf16().chain(std::iter::once(0)).collect();
            link.SetArguments(windows::core::PCWSTR(args_wide.as_ptr()))?;
            let title_wide: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
            link.SetDescription(windows::core::PCWSTR(title_wide.as_ptr()))?;
            Ok(link)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_args_open_a_new_local_window() {
        assert_eq!(
            launch_action(&["vibex".into(), "--new-window".into()]),
            Some(LaunchAction::NewWindow)
        );
    }

    #[test]
    fn launch_args_open_local_settings() {
        assert_eq!(
            launch_action(&["vibex".into(), "--open-settings".into()]),
            Some(LaunchAction::OpenSettings)
        );
    }

    #[test]
    fn launch_args_ignore_unrelated_values() {
        assert_eq!(launch_action(&["vibex".into(), "vibex://x".into()]), None);
        assert_eq!(launch_action(&["vibex".into()]), None);
    }

    #[test]
    fn app_menu_keeps_native_edit_commands() {
        assert_eq!(EDIT_MENU_TITLE, "编辑");
        let source = include_str!("app_chrome.rs");
        let install = source.split("#[cfg(test)]").next().expect("install source");
        for command in [
            ".undo()",
            ".redo()",
            ".cut()",
            ".copy()",
            ".paste()",
            ".select_all()",
        ] {
            assert!(
                install.contains(command),
                "app menu must keep native {command} so macOS delivers copy and paste"
            );
        }
        assert!(install.contains("EDIT_MENU_TITLE"));
    }
}
