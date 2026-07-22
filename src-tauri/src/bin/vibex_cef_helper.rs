fn main() {
    match browser_cef::bootstrap().expect("failed to bootstrap CEF helper process") {
        browser_cef::CefProcess::Child(exit_code) => std::process::exit(exit_code),
        browser_cef::CefProcess::Browser(_) => {
            panic!("CEF helper was launched without a subprocess type")
        }
    }
}
