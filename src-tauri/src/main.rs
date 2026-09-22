// VibeX is a GUI application in every Windows build profile. Keeping this
// conditional on `debug_assertions` makes debug installers allocate a console
// before Tauri creates the main window.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    // Must run before Tauri constructs the first WebView2 environment.
    vibex::windows_webview2::install_process_arguments();

    vibex::run();
}
