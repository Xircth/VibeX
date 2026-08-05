#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    vibex::linux_display::configure_cef_display_backend();

    match browser_cef::bootstrap() {
        Ok(browser_cef::CefProcess::Browser(bootstrap)) => vibex::run(Ok(bootstrap)),
        Ok(browser_cef::CefProcess::Child(exit_code)) => std::process::exit(exit_code),
        Err(error) => vibex::run(Err(error.to_string())),
    }
}
