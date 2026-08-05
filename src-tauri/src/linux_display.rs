use std::ffi::OsStr;

/// Selects the GTK backend required by native, windowed CEF on Linux.
///
/// Wayland sessions normally expose an XWayland display through `DISPLAY`.
/// When it is present, forcing GTK to X11 makes Tauri create the X11/XCB
/// parent handle that CEF requires.
pub fn cef_gdk_backend(display: Option<&OsStr>) -> Option<&'static str> {
    display.filter(|value| !value.is_empty()).map(|_| "x11")
}

#[cfg(target_os = "linux")]
pub fn configure_cef_display_backend() {
    let display = std::env::var_os("DISPLAY");
    if let Some(backend) = cef_gdk_backend(display.as_deref()) {
        // SAFETY: `main` calls this before CEF, GTK, Tauri, or any worker
        // threads are initialized, so no other thread can concurrently read
        // or mutate the process environment.
        unsafe { std::env::set_var("GDK_BACKEND", backend) };
    }
}
