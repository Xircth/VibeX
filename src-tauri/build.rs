use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=icons");

    prepare_host_sidecar_stubs();

    tauri_build::build();

    #[cfg(target_os = "linux")]
    println!(
        "cargo:rustc-link-arg-bins=-Wl,-rpath,$ORIGIN:$ORIGIN/../lib/vibex:$ORIGIN/../lib/VibeX"
    );
}

fn prepare_host_sidecar_stubs() {
    let manifest_dir = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap());
    let triple = std::env::var("TARGET").unwrap_or_else(|_| "unknown".to_string());
    let ext = if cfg!(windows) { ".exe" } else { "" };
    let binaries = manifest_dir.join("binaries");
    let _ = std::fs::create_dir_all(&binaries);
    for name in ["vibex-mcp", "vibex-workflow-mcp"] {
        let path = binaries.join(format!("{name}-{triple}{ext}"));
        if !path.is_file() {
            let _ = std::fs::write(&path, []);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Ok(metadata) = std::fs::metadata(&path) {
                    let mut permissions = metadata.permissions();
                    permissions.set_mode(0o755);
                    let _ = std::fs::set_permissions(&path, permissions);
                }
            }
        }
    }
}
