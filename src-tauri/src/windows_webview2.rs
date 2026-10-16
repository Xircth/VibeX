//! Windows WebView2 process arguments applied before the first environment.
//!
//! Keep WebView2 aligned with Codeg's lean Chromium defaults: allow Windows
//! native-window occlusion and compositor surface eviction when windows or
//! surfaces are hidden/backgrounded, let V8 manage old-space dynamically
//! without a 1.5 GB floor, and disable non-essential Edge/Chromium background
//! features (`Translate`, `OptimizationHints`, `MediaRouter`, Edge OOUI).

pub const ADDITIONAL_BROWSER_ARGUMENTS_ENV: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";

/// Non-essential Chromium/Edge features disabled in the main WebView2.
pub const OCCLUSION_DISABLE_FEATURES: &str =
    "Translate,OptimizationHints,MediaRouter,msWebOOUI,msPdfOOUI,msSmartScreenProtection";

pub const ADDITIONAL_BROWSER_ARGUMENTS: &str = "--disable-features=Translate,OptimizationHints,MediaRouter,msWebOOUI,msPdfOOUI,msSmartScreenProtection --disk-cache-size=33554432";

/// Decide the process-wide WebView2 argument string.
///
/// `None` means leave the environment unchanged: an explicit user/IT value is
/// respected so this stays opt-out and easy to roll back.
pub fn additional_browser_arguments_to_install(existing: Option<&str>) -> Option<&'static str> {
    match existing.map(str::trim).filter(|value| !value.is_empty()) {
        Some(_) => None,
        None => Some(ADDITIONAL_BROWSER_ARGUMENTS),
    }
}

pub const INTERACTIVE_DESKTOP_RELAUNCHED_ENV: &str = "VIBEX_INTERACTIVE_DESKTOP_RELAUNCHED";
pub const SANDBOX_PARENT_PID_ENV: &str = "VIBEX_SANDBOX_PARENT_PID";

/// Returns true when the process was launched inside an isolated `exebox-*`
/// desktop (for example, an IDE agent terminal sandbox on Windows) and must
/// re-spawn onto `WinSta0\Default` so its GUI window and WebView2 child
/// processes appear on the user's interactive desktop.
pub fn should_relaunch_on_interactive_desktop(
    desktop_name: Option<&str>,
    already_relaunched: bool,
) -> bool {
    if already_relaunched {
        return false;
    }
    desktop_name
        .map(str::trim)
        .is_some_and(|name| name.starts_with("exebox-"))
}

/// Install the occlusion-disable arguments before Tauri creates a WebView2
/// environment, and escape non-interactive `exebox-*` desktops on Windows.
pub fn install_process_arguments() {
    #[cfg(windows)]
    {
        win32_desktop::relaunch_on_interactive_desktop_if_sandboxed();

        let existing = std::env::var(ADDITIONAL_BROWSER_ARGUMENTS_ENV).ok();
        let Some(arguments) = additional_browser_arguments_to_install(existing.as_deref()) else {
            return;
        };
        // SAFETY: `main` / `run` call this before Tauri, WebView2, or worker
        // threads are initialized, so no other thread can concurrently read or
        // mutate the process environment.
        unsafe { std::env::set_var(ADDITIONAL_BROWSER_ARGUMENTS_ENV, arguments) };
    }
}

#[cfg(windows)]
mod win32_desktop {
    use std::{
        ffi::OsString,
        os::windows::ffi::OsStringExt,
        ptr::{null, null_mut},
    };

    use super::{
        INTERACTIVE_DESKTOP_RELAUNCHED_ENV, SANDBOX_PARENT_PID_ENV,
        should_relaunch_on_interactive_desktop,
    };

    type Handle = *mut core::ffi::c_void;
    type Bool = i32;
    type Dword = u32;

    const UOI_NAME: i32 = 2;
    const STARTF_USESTDHANDLES: Dword = 0x0000_0100;
    const STD_INPUT_HANDLE: Dword = -10i32 as Dword;
    const STD_OUTPUT_HANDLE: Dword = -11i32 as Dword;
    const STD_ERROR_HANDLE: Dword = -12i32 as Dword;
    const SYNCHRONIZE: Dword = 0x0010_0000;
    const INFINITE: Dword = 0xFFFF_FFFF;

    #[repr(C)]
    struct StartupInfoW {
        cb: Dword,
        lp_reserved: *mut u16,
        lp_desktop: *mut u16,
        lp_title: *mut u16,
        dw_x: Dword,
        dw_y: Dword,
        dw_x_size: Dword,
        dw_y_size: Dword,
        dw_x_count_chars: Dword,
        dw_y_count_chars: Dword,
        dw_fill_attribute: Dword,
        dw_flags: Dword,
        w_show_window: u16,
        cb_reserved2: u16,
        lp_reserved2: *mut u8,
        h_std_input: Handle,
        h_std_output: Handle,
        h_std_error: Handle,
    }

    #[repr(C)]
    struct ProcessInformation {
        h_process: Handle,
        h_thread: Handle,
        dw_process_id: Dword,
        dw_thread_id: Dword,
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetThreadDesktop(dw_thread_id: Dword) -> Handle;
        fn GetUserObjectInformationW(
            h_obj: Handle,
            n_index: i32,
            pv_info: *mut core::ffi::c_void,
            n_length: Dword,
            lpn_length_needed: *mut Dword,
        ) -> Bool;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentThreadId() -> Dword;
        fn GetCommandLineW() -> *const u16;
        fn GetStdHandle(n_std_handle: Dword) -> Handle;
        fn CreateProcessW(
            lp_application_name: *const u16,
            lp_command_line: *mut u16,
            lp_process_attributes: *const core::ffi::c_void,
            lp_thread_attributes: *const core::ffi::c_void,
            b_inherit_handles: Bool,
            dw_creation_flags: Dword,
            lp_environment: *const core::ffi::c_void,
            lp_current_directory: *const u16,
            lp_startup_info: *const StartupInfoW,
            lp_process_information: *mut ProcessInformation,
        ) -> Bool;
        fn WaitForSingleObject(h_handle: Handle, dw_milliseconds: Dword) -> Dword;
        fn GetExitCodeProcess(h_process: Handle, lp_exit_code: *mut Dword) -> Bool;
        fn OpenProcess(
            dw_desired_access: Dword,
            b_inherit_handle: Bool,
            dw_process_id: Dword,
        ) -> Handle;
        fn CloseHandle(h_object: Handle) -> Bool;
    }

    fn current_desktop_name() -> Option<String> {
        unsafe {
            let h_desk = GetThreadDesktop(GetCurrentThreadId());
            if h_desk.is_null() {
                return None;
            }
            let mut buf = [0u16; 256];
            let mut needed: Dword = 0;
            let ok = GetUserObjectInformationW(
                h_desk,
                UOI_NAME,
                buf.as_mut_ptr().cast(),
                (buf.len() * std::mem::size_of::<u16>()) as Dword,
                &mut needed,
            );
            if ok == 0 {
                return None;
            }
            let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            Some(
                OsString::from_wide(&buf[..len])
                    .to_string_lossy()
                    .into_owned(),
            )
        }
    }

    fn install_parent_lifeline_if_needed() {
        let Some(parent_pid) = std::env::var(SANDBOX_PARENT_PID_ENV)
            .ok()
            .and_then(|raw| raw.trim().parse::<u32>().ok())
        else {
            return;
        };

        std::thread::spawn(move || unsafe {
            let parent = OpenProcess(SYNCHRONIZE, 0, parent_pid);
            if parent.is_null() {
                std::process::exit(0);
            }
            WaitForSingleObject(parent, INFINITE);
            CloseHandle(parent);
            std::process::exit(0);
        });
    }

    pub fn relaunch_on_interactive_desktop_if_sandboxed() {
        install_parent_lifeline_if_needed();

        let already_relaunched = std::env::var_os(INTERACTIVE_DESKTOP_RELAUNCHED_ENV).is_some();
        let desktop_name = current_desktop_name();
        if !should_relaunch_on_interactive_desktop(desktop_name.as_deref(), already_relaunched) {
            return;
        }

        unsafe {
            std::env::set_var(INTERACTIVE_DESKTOP_RELAUNCHED_ENV, "1");
            std::env::set_var(SANDBOX_PARENT_PID_ENV, std::process::id().to_string());

            let cmd_ptr = GetCommandLineW();
            if cmd_ptr.is_null() {
                return;
            }
            let mut cmd_len = 0usize;
            while *cmd_ptr.add(cmd_len) != 0 {
                cmd_len += 1;
            }
            let mut cmd_buf: Vec<u16> = std::slice::from_raw_parts(cmd_ptr, cmd_len + 1).to_vec();

            let mut desktop_wide: Vec<u16> = "WinSta0\\Default"
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();

            let si = StartupInfoW {
                cb: std::mem::size_of::<StartupInfoW>() as Dword,
                lp_reserved: null_mut(),
                lp_desktop: desktop_wide.as_mut_ptr(),
                lp_title: null_mut(),
                dw_x: 0,
                dw_y: 0,
                dw_x_size: 0,
                dw_y_size: 0,
                dw_x_count_chars: 0,
                dw_y_count_chars: 0,
                dw_fill_attribute: 0,
                dw_flags: STARTF_USESTDHANDLES,
                w_show_window: 0,
                cb_reserved2: 0,
                lp_reserved2: null_mut(),
                h_std_input: GetStdHandle(STD_INPUT_HANDLE),
                h_std_output: GetStdHandle(STD_OUTPUT_HANDLE),
                h_std_error: GetStdHandle(STD_ERROR_HANDLE),
            };

            let mut pi = ProcessInformation {
                h_process: null_mut(),
                h_thread: null_mut(),
                dw_process_id: 0,
                dw_thread_id: 0,
            };

            let ok = CreateProcessW(
                null(),
                cmd_buf.as_mut_ptr(),
                null(),
                null(),
                1,
                0,
                null(),
                null(),
                &si,
                &mut pi,
            );
            if ok == 0 {
                return;
            }

            CloseHandle(pi.h_thread);
            WaitForSingleObject(pi.h_process, INFINITE);
            let mut exit_code: Dword = 0;
            GetExitCodeProcess(pi.h_process, &mut exit_code);
            CloseHandle(pi.h_process);
            std::process::exit(exit_code as i32);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ADDITIONAL_BROWSER_ARGUMENTS, additional_browser_arguments_to_install,
        should_relaunch_on_interactive_desktop,
    };

    #[test]
    fn installs_occlusion_flags_when_the_environment_is_unset() {
        assert_eq!(
            additional_browser_arguments_to_install(None),
            Some(ADDITIONAL_BROWSER_ARGUMENTS)
        );
        assert_eq!(
            additional_browser_arguments_to_install(Some("")),
            Some(ADDITIONAL_BROWSER_ARGUMENTS)
        );
        assert_eq!(
            additional_browser_arguments_to_install(Some("   ")),
            Some(ADDITIONAL_BROWSER_ARGUMENTS)
        );
    }

    #[test]
    fn respects_an_explicit_user_override() {
        assert_eq!(
            additional_browser_arguments_to_install(Some("--disable-gpu")),
            None
        );
        assert_eq!(
            additional_browser_arguments_to_install(Some(ADDITIONAL_BROWSER_ARGUMENTS)),
            None
        );
    }

    #[test]
    fn detects_when_sandbox_desktop_must_relaunch_to_default() {
        assert!(should_relaunch_on_interactive_desktop(
            Some("exebox-MD5PHOMY7TUXHZHFO6C2J2Z4I7"),
            false
        ));
        assert!(!should_relaunch_on_interactive_desktop(
            Some("exebox-MD5PHOMY7TUXHZHFO6C2J2Z4I7"),
            true
        ));
        assert!(!should_relaunch_on_interactive_desktop(
            Some("Default"),
            false
        ));
        assert!(!should_relaunch_on_interactive_desktop(None, false));
    }

    #[test]
    fn keeps_v8_heap_and_native_occlusion_at_lean_chromium_defaults() {
        assert!(!ADDITIONAL_BROWSER_ARGUMENTS.contains("--max-old-space-size"));
        assert!(!ADDITIONAL_BROWSER_ARGUMENTS.contains("CalculateNativeWinOcclusion"));
        assert!(!ADDITIONAL_BROWSER_ARGUMENTS.contains("ApplyNativeOcclusionToCompositor"));
        assert!(ADDITIONAL_BROWSER_ARGUMENTS.contains("--disk-cache-size=33554432"));
    }
}
