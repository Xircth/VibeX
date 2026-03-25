#[cfg(windows)]
use std::path::{Path, PathBuf};

fn main() {
    tauri_build::build();

    #[cfg(windows)]
    println!("cargo:rustc-link-arg-bins=/NODEFAULTLIB:resource.lib");

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
