use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=icons");

    prepare_cef_bundle_root();

    #[cfg(target_os = "macos")]
    prepare_macos_cef_bundle_inputs();

    tauri_build::build();

    #[cfg(target_os = "linux")]
    println!(
        "cargo:rustc-link-arg-bins=-Wl,-rpath,$ORIGIN:$ORIGIN/../lib/vibex:$ORIGIN/../lib/VibeX"
    );
}

fn prepare_cef_bundle_root() {
    let manifest_dir = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let bundle_root = manifest_dir
        .join("../target/cef-runtime")
        .join(std::env::consts::OS);
    std::fs::create_dir_all(bundle_root).expect("failed to prepare CEF bundle root");
}

#[cfg(target_os = "macos")]
fn prepare_macos_cef_bundle_inputs() {
    let manifest_dir = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let frameworks =
        manifest_dir.join("../target/cef-runtime/macos/app/vibex.app/Contents/Frameworks");
    let bundle_inputs = [
        frameworks.join("Chromium Embedded Framework.framework"),
        manifest_dir.join("../target/cef-runtime/macos/framework-links"),
    ];
    for bundle_input in bundle_inputs {
        std::fs::create_dir_all(bundle_input).expect("failed to prepare CEF bundle input path");
    }
    let manifest = manifest_dir.join("../target/cef-runtime/macos/cef-runtime-manifest.json");
    if !manifest.is_file() {
        std::fs::write(manifest, "{}\n").expect("failed to prepare CEF runtime manifest");
    }
}
