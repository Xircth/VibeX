#[cfg(windows)]
use std::path::Path;
#[cfg(any(windows, target_os = "macos"))]
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=icons");

    #[cfg(target_os = "macos")]
    prepare_macos_cef_bundle_inputs();

    tauri_build::build();

    #[cfg(windows)]
    println!("cargo:rustc-link-arg-bins=/NODEFAULTLIB:resource.lib");

    #[cfg(target_os = "linux")]
    println!(
        "cargo:rustc-link-arg-bins=-Wl,-rpath,$ORIGIN:$ORIGIN/../lib/vibex:$ORIGIN/../lib/VibeX"
    );

    // codex-windows-sandbox embeds a Windows VERSION resource via winres,
    // which conflicts with tauri-build's own VERSION resource at link time
    // (CVTRES fatal error CVT1100: duplicate resource).
    //
    // Fix: after tauri_build generates our resource.lib, replace the
    // codex-windows-sandbox resource.lib with a minimal empty COFF object
    // so CVTRES sees no duplicate VERSION resource.
    #[cfg(windows)]
    neutralize_codex_sandbox_resource();
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

#[cfg(windows)]
fn neutralize_codex_sandbox_resource() {
    let out_path = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR not set"));
    // OUT_DIR = target/<profile>/build/<pkg>-<hash>/out
    // Walk up to the build/ directory
    let build_dir = out_path
        .parent() // <pkg>-<hash>
        .and_then(|p| p.parent()) // build
        .expect("Could not derive build dir from OUT_DIR");

    let replacement_lib = generate_empty_static_library(&out_path)
        .expect("Failed to generate replacement static library for codex sandbox resource");

    if let Ok(entries) = std::fs::read_dir(build_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name.to_string_lossy().starts_with("codex-windows-sandbox-") {
                let resource_lib = entry.path().join("out").join("resource.lib");
                if resource_lib.exists() {
                    let _ = std::fs::copy(&replacement_lib, &resource_lib);
                }
            }
        }
    }
}

#[cfg(windows)]
fn generate_empty_static_library(out_dir: &Path) -> Option<PathBuf> {
    let source = out_dir.join("codex_windows_sandbox_empty_resource.c");
    std::fs::write(
        &source,
        "void codex_windows_sandbox_empty_resource(void) {}\n",
    )
    .ok()?;

    cc::Build::new()
        .file(&source)
        .out_dir(out_dir)
        .cargo_metadata(false)
        .compile("codex_windows_sandbox_empty_resource");

    let candidates = [
        out_dir.join("codex_windows_sandbox_empty_resource.lib"),
        out_dir.join("libcodex_windows_sandbox_empty_resource.a"),
    ];

    candidates.into_iter().find(|candidate| candidate.exists())
}
