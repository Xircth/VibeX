//! Windows WebView2 process arguments applied before the first environment.
//!
//! Keep WebView2 aligned with Codeg's lean Chromium defaults: allow Windows
//! native-window occlusion and compositor surface eviction when windows or
//! surfaces are hidden/backgrounded, let V8 manage old-space dynamically
//! without a 1.5 GB floor, and disable non-essential Edge/Chromium background
//! features (`Translate`, `OptimizationHints`, `MediaRouter`, Edge OOUI).

use std::sync::{Mutex, OnceLock};

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

/// Returns true when the current process is running in an `exebox-*` sandbox
/// desktop, was relaunched from a sandbox parent (`VIBEX_SANDBOX_PARENT_PID`),
/// or is executing directly from a Cargo build directory (`target\debug` or
/// `target\release`). Normal installed production builds skip SACL rewrites.
pub fn should_apply_medium_integrity_sacl(
    desktop_name: Option<&str>,
    has_sandbox_parent: bool,
    exe: Option<&std::path::Path>,
) -> bool {
    if has_sandbox_parent {
        return true;
    }
    if desktop_name
        .map(str::trim)
        .is_some_and(|name| name.starts_with("exebox-"))
    {
        return true;
    }
    exe.is_some_and(|path| {
        let lower = path
            .to_string_lossy()
            .replace('/', "\\")
            .to_ascii_lowercase();
        let dir = lower
            .rsplit_once('\\')
            .map(|(parent, _)| parent)
            .unwrap_or(&lower);
        dir.ends_with("\\target\\debug") || dir.ends_with("\\target\\release")
    })
}

/// WebView2 user-data folder identifier for this executable.
///
/// `pnpm run dev` uses `com.vibex.app.dev`; the installed product uses
/// `com.vibex.app`. The two must stay distinct so a running install cannot
/// busy-lock a debug restart.
pub fn webview2_identifier_for_executable(exe: &std::path::Path) -> &'static str {
    let text = exe
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase();
    if text.contains("\\target\\debug\\") {
        "com.vibex.app.dev"
    } else {
        "com.vibex.app"
    }
}

/// PowerShell `-like` pattern for leftover `msedgewebview2.exe` command lines.
///
/// `com.vibex.app` is a prefix of `com.vibex.app.dev`, so the product pattern
/// matches the `EBWebView` path segment instead of the identifier alone.
pub fn webview2_command_line_like_pattern(identifier: &str) -> &'static str {
    if identifier == "com.vibex.app.dev" {
        "*com.vibex.app.dev*"
    } else {
        "*\\com.vibex.app\\EBWebView*"
    }
}

/// WebView2 user-data root: `%LOCALAPPDATA%\<identifier>`.
pub fn webview2_user_data_dir(identifier: &str) -> Option<std::path::PathBuf> {
    std::env::var_os("LOCALAPPDATA")
        .filter(|value| !value.is_empty())
        .map(|root| std::path::PathBuf::from(root).join(identifier))
}

/// Isolated debug WebView2 environment under the repo `dev_assets` tree.
///
/// Tauri's default is `%LOCALAPPDATA%\com.vibex.app.dev`. That folder stays
/// busy across cargo-watch restarts (`HRESULT 0x800700AA`), and creating a
/// nested or sibling directory there can fail with access denied while the
/// leftover Environment still holds it. Host windows already keep profiles
/// in `dev_assets/webview-profiles`; debug `main` uses the same tree.
pub fn debug_webview2_environment_dir() -> std::path::PathBuf {
    utils::assets::asset_dir()
        .join("webview-profiles")
        .join("main")
}

/// Sidecar profile used when `webview-profiles/main` cannot be created.
pub fn fresh_debug_webview2_user_data_dir(pid: u32) -> std::path::PathBuf {
    utils::assets::asset_dir()
        .join("webview-profiles")
        .join(format!("main-run-{pid}"))
}

static ACTIVE_DEBUG_WEBVIEW2_ENV_DIR: OnceLock<Mutex<Option<std::path::PathBuf>>> = OnceLock::new();

/// Record the actual WebView2 user-data directory chosen for the debug `main`
/// window so secondary local windows (`settings`, `app-*`, `desktop-toast`)
/// reuse the same `WebContext` even when `main` fell back to `main-run-<pid>`.
pub fn set_active_debug_webview2_environment_dir(dir: std::path::PathBuf) {
    let cell = ACTIVE_DEBUG_WEBVIEW2_ENV_DIR.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = cell.lock() {
        *guard = Some(dir);
    }
}

/// Return the active debug WebView2 user-data directory shared by all local
/// desktop windows (`main`, `settings`, `app-*`, `desktop-toast`).
pub fn active_debug_webview2_environment_dir() -> std::path::PathBuf {
    ACTIVE_DEBUG_WEBVIEW2_ENV_DIR
        .get()
        .and_then(|cell| cell.lock().ok().and_then(|guard| guard.clone()))
        .unwrap_or_else(debug_webview2_environment_dir)
}

/// Move the whole identifier directory aside so a new Environment can be created.
///
/// Tauri passes `app_local_data_dir()` (`%LOCALAPPDATA%\<identifier>`) to
/// `CreateCoreWebView2EnvironmentWithOptions`. Killing `msedgewebview2.exe` is
/// not enough: Windows still reports `HRESULT(0x800700AA)` until every handle
/// on that folder is gone. Debug restarts relocate the folder instead of
/// waiting on Defender/search indexer.
pub fn relocate_webview2_user_data(
    dir: &std::path::Path,
) -> std::io::Result<Option<std::path::PathBuf>> {
    if !dir.exists() {
        return Ok(None);
    }
    let Some(parent) = dir.parent() else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "webview2 user data dir has no parent",
        ));
    };
    let name = dir.file_name().unwrap_or_default().to_string_lossy();

    let mut last_error = None;
    for _ in 0..10 {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        let stale = parent.join(format!("{name}.stale-{stamp}"));
        match std::fs::rename(dir, &stale) {
            Ok(()) => return Ok(Some(stale)),
            Err(error) => {
                last_error = Some(error);
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
        }
    }
    Err(last_error.unwrap_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::DirectoryNotEmpty,
            "failed to relocate WebView2 user data",
        )
    }))
}

/// Best-effort cleanup of previous debug relocations.
pub fn remove_stale_webview2_user_data(dir: &std::path::Path) {
    let Some(parent) = dir.parent() else {
        return;
    };
    let Some(name) = dir.file_name().and_then(|name| name.to_str()) else {
        return;
    };
    let prefix = format!("{name}.stale-");
    let Ok(entries) = std::fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        let entry_name = entry.file_name();
        let Some(entry_name) = entry_name.to_str() else {
            continue;
        };
        if entry_name.starts_with(&prefix) {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// Drop leftover `main-run-<pid>` profiles from previous debug launches.
pub fn remove_stale_debug_run_user_data(profiles_dir: &std::path::Path, keep_pid: u32) {
    let Ok(entries) = std::fs::read_dir(profiles_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(rest) = name.strip_prefix("main-run-") else {
            continue;
        };
        if rest.parse::<u32>().ok() == Some(keep_pid) {
            continue;
        }
        let _ = std::fs::remove_dir_all(entry.path());
    }
}

/// Install the occlusion-disable arguments before Tauri creates a WebView2
/// environment, and escape non-interactive `exebox-*` desktops on Windows.
pub fn install_process_arguments() {
    #[cfg(windows)]
    {
        static INSTALLED: OnceLock<()> = OnceLock::new();
        if INSTALLED.set(()).is_err() {
            return;
        }
        win32_desktop::ensure_runtime_dirs_medium_integrity();
        win32_desktop::relaunch_on_interactive_desktop_if_sandboxed();
        win32_desktop::reclaim_orphaned_webview2_user_data();

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

/// Returns `true` when an existing WebView2 process still holds an open handle
/// on the profile's `EBWebView\Default\LOCK` or `EBWebView\Crashpad\settings.dat`.
pub fn webview2_user_data_is_locked(dir: &std::path::Path) -> bool {
    let ebwebview = dir.join("EBWebView");
    if !ebwebview.exists() {
        return false;
    }
    for sentinel in [
        ebwebview.join("Default").join("LOCK"),
        ebwebview.join("Crashpad").join("settings.dat"),
    ] {
        if is_file_handle_contended(&sentinel) {
            return true;
        }
    }
    false
}

fn is_file_handle_contended(path: &std::path::Path) -> bool {
    if !path.exists() {
        return false;
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }
    match options.open(path) {
        Ok(_file) => false,
        Err(error) => error.kind() != std::io::ErrorKind::NotFound,
    }
}

#[cfg(any(windows, test))]
pub(crate) fn build_reclaim_orphaned_webview2_script(
    exe: &std::path::Path,
    identifier: &str,
    self_pid: u32,
    sandbox_parent_pid: Option<u32>,
    wait_ms: u128,
) -> String {
    let like = webview2_command_line_like_pattern(identifier);
    let exe_literal = format!("'{}'", exe.to_string_lossy().replace('\'', "''"));
    let parent_pid = sandbox_parent_pid.unwrap_or(0);
    let force_kill_predecessor = if identifier == "com.vibex.app.dev" {
        "$true"
    } else {
        "$false"
    };
    format!(
        "$self = {self_pid}; $parentPid = {parent_pid}; $exe = [System.IO.Path]::GetFullPath({exe_literal}); $force = {force_kill_predecessor}; $deadline = [DateTime]::UtcNow.AddMilliseconds({wait_ms}); $others = @(); do {{ $others = @(Get-CimInstance Win32_Process -Filter \"Name = 'vibex.exe'\" | Where-Object {{ $_.ProcessId -ne $self -and $_.ProcessId -ne $parentPid -and $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath) -ieq $exe) }}); if ($others.Count -eq 0) {{ break }}; Start-Sleep -Milliseconds 200 }} while ([DateTime]::UtcNow -lt $deadline); $wv2 = @(Get-CimInstance Win32_Process -Filter \"Name = 'msedgewebview2.exe'\" | Where-Object {{ $_.CommandLine -and $_.CommandLine -like '{like}' }}); if ($others.Count -gt 0) {{ if (-not $force -and $wv2.Count -gt 0) {{ exit 0 }}; $others | ForEach-Object {{ taskkill.exe /F /PID $_.ProcessId /T | Out-Null; Wait-Process -Id $_.ProcessId -Timeout 8 -ErrorAction SilentlyContinue }} }}; $wv2 | ForEach-Object {{ taskkill.exe /F /PID $_.ProcessId /T | Out-Null; Wait-Process -Id $_.ProcessId -Timeout 8 -ErrorAction SilentlyContinue }}; Start-Sleep -Milliseconds 400"
    )
}

#[cfg(windows)]
mod win32_desktop {
    use std::{
        ffi::OsString,
        os::windows::ffi::{OsStrExt, OsStringExt},
        path::Path,
        process::{Command, Stdio},
        ptr::{null, null_mut},
        time::Duration,
    };

    use super::{
        INTERACTIVE_DESKTOP_RELAUNCHED_ENV, SANDBOX_PARENT_PID_ENV,
        build_reclaim_orphaned_webview2_script, debug_webview2_environment_dir,
        remove_stale_debug_run_user_data, remove_stale_webview2_user_data,
        should_apply_medium_integrity_sacl, should_relaunch_on_interactive_desktop,
        webview2_identifier_for_executable, webview2_user_data_dir, webview2_user_data_is_locked,
    };

    const PREVIOUS_EXE_WAIT: Duration = Duration::from_secs(3);

    fn webview2_identity_needs_reclaim(identifier: &str, user_data: Option<&Path>) -> bool {
        if user_data.is_some_and(webview2_user_data_is_locked) {
            return true;
        }
        if identifier == "com.vibex.app.dev"
            && webview2_user_data_is_locked(&debug_webview2_environment_dir())
        {
            return true;
        }
        false
    }

    /// Wait for a cargo-watch predecessor to exit, then reap WebView2 children
    /// still holding this identity's user-data folder (`0x800700AA`).
    ///
    /// On a normal cold start where neither the identity `EBWebView` folder nor
    /// the debug profile holds an active `LOCK`/`Crashpad` handle, skip
    /// spawning `powershell.exe` altogether and clean up any `.stale-*`
    /// leftovers in the background.
    pub fn reclaim_orphaned_webview2_user_data() {
        let Ok(exe) = std::env::current_exe() else {
            return;
        };
        let identifier = webview2_identifier_for_executable(&exe);
        let self_pid = std::process::id();
        let user_data = webview2_user_data_dir(identifier);

        if webview2_identity_needs_reclaim(identifier, user_data.as_deref()) {
            let sandbox_parent_pid = std::env::var(SANDBOX_PARENT_PID_ENV)
                .ok()
                .and_then(|raw| raw.trim().parse::<u32>().ok());
            let wait_ms = PREVIOUS_EXE_WAIT.as_millis();
            let script = build_reclaim_orphaned_webview2_script(
                &exe,
                identifier,
                self_pid,
                sandbox_parent_pid,
                wait_ms,
            );
            let mut command = Command::new("powershell.exe");
            utils::process::configure_std_command_no_window(&mut command);
            let _ = command
                .args([
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    &script,
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }

        let Some(user_data) = user_data else {
            return;
        };
        let _ = std::thread::Builder::new()
            .name("wv2-stale-cleanup".to_string())
            .spawn(move || {
                remove_stale_webview2_user_data(&user_data);
                if identifier == "com.vibex.app.dev" {
                    remove_stale_debug_run_user_data(
                        &utils::assets::asset_dir().join("webview-profiles"),
                        self_pid,
                    );
                }
            });
    }

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
    const WRITE_OWNER: Dword = 0x0008_0000;
    const READ_CONTROL: Dword = 0x0002_0000;
    const FILE_SHARE_READ: Dword = 0x0000_0001;
    const FILE_SHARE_WRITE: Dword = 0x0000_0002;
    const FILE_SHARE_DELETE: Dword = 0x0000_0004;
    const OPEN_EXISTING: Dword = 3;
    const FILE_FLAG_BACKUP_SEMANTICS: Dword = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: Dword = 0x0020_0000;
    const LABEL_SECURITY_INFORMATION: Dword = 0x0000_0010;
    const SDDL_REVISION_1: Dword = 1;
    const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;

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
        fn CreateFileW(
            lp_file_name: *const u16,
            dw_desired_access: Dword,
            dw_share_mode: Dword,
            lp_security_attributes: *const core::ffi::c_void,
            dw_creation_disposition: Dword,
            dw_flags_and_attributes: Dword,
            h_template_file: Handle,
        ) -> Handle;
        fn LocalFree(h_mem: Handle) -> Handle;
        fn WaitForSingleObject(h_handle: Handle, dw_milliseconds: Dword) -> Dword;
        fn GetExitCodeProcess(h_process: Handle, lp_exit_code: *mut Dword) -> Bool;
        fn OpenProcess(
            dw_desired_access: Dword,
            b_inherit_handle: Bool,
            dw_process_id: Dword,
        ) -> Handle;
        fn CloseHandle(h_object: Handle) -> Bool;
    }

    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
            string_security_descriptor: *const u16,
            string_sd_revision: Dword,
            security_descriptor: *mut Handle,
            security_descriptor_size: *mut Dword,
        ) -> Bool;
    }

    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtSetSecurityObject(
            handle: Handle,
            security_information: Dword,
            security_descriptor: Handle,
        ) -> i32;
    }

    fn set_path_sacl_sd(path: &Path, sd: Handle) {
        if !path.exists() {
            return;
        }
        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        unsafe {
            let handle = CreateFileW(
                wide.as_ptr(),
                WRITE_OWNER | READ_CONTROL,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                null_mut(),
            );
            if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
                let _ = NtSetSecurityObject(handle, LABEL_SECURITY_INFORMATION, sd);
                CloseHandle(handle);
            }
        }
    }

    /// Protect `dev_assets` and the executable's `target/<profile>` directory
    /// with a non-inheriting `Medium Mandatory Level` SACL (`S:P(ML;OICI;NW;;;ME)`).
    ///
    /// External Windows agent sandboxes (`exebox`) can stamp `Low Mandatory Level`
    /// onto the workspace root; without `SE_SACL_PROTECTED`, `target\debug\vibex.exe`
    /// inherits the `Low` label, causing Windows to launch `vibex.exe` and all
    /// ACP child agents (`codex`, `claude`, `grok`, `opencode`, `antigravity`)
    /// with a Low Mandatory Integrity token (`S-1-16-4096`) that fails with
    /// `os error 5` (`ERROR_ACCESS_DENIED`) when writing to `%USERPROFILE%`.
    pub fn ensure_runtime_dirs_medium_integrity() {
        let desktop_name = current_desktop_name();
        let has_sandbox_parent = std::env::var_os(SANDBOX_PARENT_PID_ENV).is_some();
        let current_exe = std::env::current_exe().ok();
        if !should_apply_medium_integrity_sacl(
            desktop_name.as_deref(),
            has_sandbox_parent,
            current_exe.as_deref(),
        ) {
            return;
        }
        let dir_sddl: Vec<u16> = "S:P(ML;OICI;NW;;;ME)"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let file_sddl: Vec<u16> = "S:P(ML;;NW;;;ME)"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        unsafe {
            let mut dir_sd: Handle = null_mut();
            let mut dir_sd_size: Dword = 0;
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(
                dir_sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut dir_sd,
                &mut dir_sd_size,
            ) == 0
            {
                return;
            }
            let mut file_sd: Handle = null_mut();
            let mut file_sd_size: Dword = 0;
            let has_file_sd = ConvertStringSecurityDescriptorToSecurityDescriptorW(
                file_sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut file_sd,
                &mut file_sd_size,
            ) != 0;

            let create_dir_all_and_fix_il = |dir: &Path| {
                let _ = std::fs::create_dir_all(dir);
                set_path_sacl_sd(dir, dir_sd);
            };

            let asset_dir = utils::assets::asset_dir();
            set_path_sacl_sd(&asset_dir, dir_sd);
            set_path_sacl_sd(&asset_dir.join("logs"), dir_sd);
            create_dir_all_and_fix_il(&asset_dir.join("webview-profiles"));
            if let Ok(exe) = std::env::current_exe() {
                let identifier = webview2_identifier_for_executable(&exe);
                if let Some(user_data) = webview2_user_data_dir(identifier) {
                    set_path_sacl_sd(&user_data, dir_sd);
                    create_dir_all_and_fix_il(&user_data.join("EBWebView"));
                }
            }
            if has_file_sd {
                for db_name in ["db.sqlite", "db.sqlite-wal", "db.sqlite-shm"] {
                    set_path_sacl_sd(&asset_dir.join(db_name), file_sd);
                }
            }

            if let Ok(exe) = std::env::current_exe() {
                if has_file_sd {
                    set_path_sacl_sd(&exe, file_sd);
                }
                if let Some(exe_dir) = exe.parent() {
                    let lower = exe_dir
                        .to_string_lossy()
                        .replace('/', "\\")
                        .to_ascii_lowercase();
                    if lower.ends_with("\\target\\debug") || lower.ends_with("\\target\\release") {
                        set_path_sacl_sd(exe_dir, dir_sd);
                        set_path_sacl_sd(&exe_dir.join("deps"), dir_sd);
                        if let Some(target_dir) = exe_dir.parent() {
                            set_path_sacl_sd(target_dir, dir_sd);
                        }
                    }
                }
            }

            if has_file_sd {
                LocalFree(file_sd);
            }
            LocalFree(dir_sd);
        }
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
        ADDITIONAL_BROWSER_ARGUMENTS, active_debug_webview2_environment_dir,
        additional_browser_arguments_to_install, debug_webview2_environment_dir,
        set_active_debug_webview2_environment_dir, should_relaunch_on_interactive_desktop,
        webview2_command_line_like_pattern, webview2_identifier_for_executable,
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

    #[test]
    fn debug_exe_uses_the_dev_webview2_identity() {
        assert_eq!(
            webview2_identifier_for_executable(std::path::Path::new(
                r"C:\Users\18190\Documents\projects\VibeX\target\debug\vibex.exe"
            )),
            "com.vibex.app.dev"
        );
        assert_eq!(
            webview2_identifier_for_executable(std::path::Path::new(
                r"C:\Users\18190\AppData\Local\VibeX\vibex.exe"
            )),
            "com.vibex.app"
        );
    }

    #[test]
    fn product_webview2_filter_does_not_match_the_dev_folder() {
        assert_eq!(
            webview2_command_line_like_pattern("com.vibex.app.dev"),
            "*com.vibex.app.dev*"
        );
        let product = webview2_command_line_like_pattern("com.vibex.app");
        assert!(product.contains(r"\com.vibex.app\EBWebView"));
        assert!(!product.contains("com.vibex.app.dev"));
    }

    #[test]
    fn relocates_ebwebview_so_a_new_environment_can_be_created() {
        let parent = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
            "target/wv2-reloc-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        let dir = parent.join("com.vibex.app.dev");
        std::fs::create_dir_all(dir.join("EBWebView").join("Default")).unwrap();
        std::fs::write(dir.join("EBWebView").join("Default").join("LOCK"), b"busy").unwrap();

        let stale = super::relocate_webview2_user_data(&dir)
            .unwrap()
            .expect("identifier dir should be moved aside");
        assert!(!dir.exists());
        assert!(
            stale
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("com.vibex.app.dev.stale-"))
        );
        assert!(
            stale
                .join("EBWebView")
                .join("Default")
                .join("LOCK")
                .exists()
        );
        assert!(super::relocate_webview2_user_data(&dir).unwrap().is_none());

        super::remove_stale_webview2_user_data(&dir);
        assert!(!stale.exists());
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn user_data_dir_appends_the_identifier() {
        let Some(dir) = super::webview2_user_data_dir("com.vibex.app.dev") else {
            return;
        };
        assert!(dir.ends_with("com.vibex.app.dev"));
    }

    #[test]
    fn fresh_debug_dir_is_beside_the_stable_debug_profile() {
        let dir = super::fresh_debug_webview2_user_data_dir(4242);
        assert!(dir.ends_with(std::path::Path::new("webview-profiles").join("main-run-4242")));
        assert_ne!(dir, super::debug_webview2_environment_dir());
    }

    #[test]
    fn active_debug_dir_tracks_fallback_and_restores_default() {
        let fallback = super::fresh_debug_webview2_user_data_dir(9876);
        set_active_debug_webview2_environment_dir(fallback.clone());
        assert_eq!(active_debug_webview2_environment_dir(), fallback);
        let default = debug_webview2_environment_dir();
        set_active_debug_webview2_environment_dir(default.clone());
        assert_eq!(active_debug_webview2_environment_dir(), default);
    }

    #[test]
    fn debug_env_dir_lives_in_dev_assets_webview_profiles() {
        let dir = super::debug_webview2_environment_dir();
        assert!(dir.ends_with(std::path::Path::new("webview-profiles").join("main")));
        if let Some(identity) = super::webview2_user_data_dir("com.vibex.app.dev") {
            assert_ne!(dir, identity);
        }
    }

    #[test]
    fn removes_stale_debug_run_dirs_except_the_live_pid() {
        let parent = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
            "target/wv2-run-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(parent.join("main-run-111")).unwrap();
        std::fs::create_dir_all(parent.join("main-run-222")).unwrap();
        std::fs::create_dir_all(parent.join("main")).unwrap();

        super::remove_stale_debug_run_user_data(&parent, 222);

        assert!(!parent.join("main-run-111").exists());
        assert!(parent.join("main-run-222").exists());
        assert!(parent.join("main").exists());
        let _ = std::fs::remove_dir_all(&parent);
    }

    #[test]
    fn reclaim_script_excludes_sandbox_parent_pid() {
        let script = super::build_reclaim_orphaned_webview2_script(
            std::path::Path::new(r"C:\Users\18190\Documents\projects\VibeX\target\debug\vibex.exe"),
            "com.vibex.app.dev",
            2000,
            Some(1000),
            3000,
        );
        assert!(script.contains("$self = 2000; $parentPid = 1000;"));
        assert!(script.contains("$_.ProcessId -ne $self -and $_.ProcessId -ne $parentPid"));
        assert!(script.contains("if (-not $force -and $wv2.Count -gt 0) { exit 0 }"));
    }

    #[test]
    fn only_applies_medium_integrity_sacl_in_sandbox_or_cargo_build_dirs() {
        assert!(!super::should_apply_medium_integrity_sacl(
            Some("Default"),
            false,
            Some(std::path::Path::new(
                r"C:\Users\18190\AppData\Local\VibeX\vibex.exe"
            )),
        ));
        assert!(super::should_apply_medium_integrity_sacl(
            Some("exebox-123"),
            false,
            Some(std::path::Path::new(
                r"C:\Users\18190\AppData\Local\VibeX\vibex.exe"
            )),
        ));
        assert!(super::should_apply_medium_integrity_sacl(
            Some("Default"),
            true,
            Some(std::path::Path::new(
                r"C:\Users\18190\AppData\Local\VibeX\vibex.exe"
            )),
        ));
        assert!(super::should_apply_medium_integrity_sacl(
            Some("Default"),
            false,
            Some(std::path::Path::new(
                r"C:\Users\18190\Documents\projects\VibeX\target\debug\vibex.exe"
            )),
        ));
        assert!(super::should_apply_medium_integrity_sacl(
            Some("Default"),
            false,
            Some(std::path::Path::new(
                r"C:\Users\18190\Documents\projects\VibeX\target\release\vibex.exe"
            )),
        ));
    }

    #[test]
    fn webview2_lock_probe_skips_unlocked_profile_and_detects_exclusive_lock() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!(
            "target/wv2-lock-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or(0)
        ));
        assert!(!super::webview2_user_data_is_locked(&dir));

        let default_dir = dir.join("EBWebView").join("Default");
        std::fs::create_dir_all(&default_dir).unwrap();
        let lock_file = default_dir.join("LOCK");
        std::fs::write(&lock_file, b"").unwrap();
        assert!(!super::webview2_user_data_is_locked(&dir));

        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            let _held = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .share_mode(0)
                .open(&lock_file)
                .unwrap();
            assert!(super::webview2_user_data_is_locked(&dir));
        }

        let _ = std::fs::remove_dir_all(&dir);
    }
}
