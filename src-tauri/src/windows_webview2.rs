//! Windows WebView2 process arguments applied before the first environment.
//!
//! Codex sessions stream into the main Tauri WebView2 for a long time, even
//! when the built-in CEF preview is never opened. On Windows 11 23H2,
//! Chromium's native-window occlusion can pin DWM/GPU compositor surfaces for
//! the life of that page, so the renderer grows across a long conversation.
//! CEF disables the same features in its own process; WebView2 must match.

pub const ADDITIONAL_BROWSER_ARGUMENTS_ENV: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";

/// Chromium features the main WebView2 must disable on Windows 23H2.
pub const OCCLUSION_DISABLE_FEATURES: &str =
    "CalculateNativeWinOcclusion,ApplyNativeOcclusionToCompositor";

pub const ADDITIONAL_BROWSER_ARGUMENTS: &str =
    "--disable-features=CalculateNativeWinOcclusion,ApplyNativeOcclusionToCompositor";

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

/// Install the occlusion-disable arguments before Tauri creates a WebView2
/// environment. No-op on non-Windows hosts and when the env var is already set.
pub fn install_process_arguments() {
    #[cfg(windows)]
    {
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

#[cfg(test)]
mod tests {
    use super::{ADDITIONAL_BROWSER_ARGUMENTS, additional_browser_arguments_to_install};

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
}
