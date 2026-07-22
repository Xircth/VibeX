#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    match browser_cef::bootstrap().expect("failed to bootstrap Chromium Embedded Framework") {
        browser_cef::CefProcess::Browser(bootstrap) => vibex::run(bootstrap),
        browser_cef::CefProcess::Child(exit_code) => std::process::exit(exit_code),
    }
}
