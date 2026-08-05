// CEF may execute this binary as a Windows subprocess. It must never allocate
// a console window, including in debug bundles used for installed smoke tests.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    match browser_cef::bootstrap().expect("failed to bootstrap CEF helper process") {
        browser_cef::CefProcess::Child(exit_code) => std::process::exit(exit_code),
        browser_cef::CefProcess::Browser(_) => {
            panic!("CEF helper was launched without a subprocess type")
        }
    }
}
