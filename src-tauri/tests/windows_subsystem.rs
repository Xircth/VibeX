const WINDOWS_GUI_SUBSYSTEM: &str =
    "#![cfg_attr(target_os = \"windows\", windows_subsystem = \"windows\")]";

#[test]
fn installed_windows_binaries_never_allocate_a_console() {
    let source = include_str!("../src/main.rs");
    assert!(
        source.lines().any(|line| line == WINDOWS_GUI_SUBSYSTEM),
        "vibex must use the Windows GUI subsystem in every build profile"
    );
}

#[test]
fn webview2_process_arguments_are_installed_before_tauri() {
    let source = include_str!("../src/main.rs");
    assert!(
        source.contains("windows_webview2::install_process_arguments"),
        "WebView2 occlusion flags must be set before the first environment"
    );
    let main_index = source
        .find("windows_webview2::install_process_arguments")
        .expect("install_process_arguments must exist");
    let run_index = source.find("vibex::run").expect("tauri run must exist");
    assert!(
        main_index < run_index,
        "WebView2 arguments must be installed before Tauri starts"
    );
}
