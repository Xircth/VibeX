//! Locate Host-family sidecar binaries (`vibex-mcp`, `vibex-workflow-mcp`).

use std::{
    fs,
    path::{Path, PathBuf},
};

/// Resolve a Host-family sidecar, skipping empty Tauri stubs.
///
/// Order: `VIBEX_MCP_BIN` / `VIBEX_WORKFLOW_MCP_BIN` → current-exe directory
/// and ancestors (including `debug`/`release`/`binaries`) → `CARGO_TARGET_DIR`
/// → `PATH`. Empty files are never returned.
pub fn locate_host_family_binary(base: &str) -> PathBuf {
    let file_name = binary_file_name(base);
    if let Some(path) = env_override(base).filter(|path| is_runnable(path)) {
        return path;
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(found) = search_from(&exe, base, &file_name)
    {
        return found;
    }
    if let Ok(target) = std::env::var("CARGO_TARGET_DIR") {
        let dir = PathBuf::from(target);
        for profile in ["debug", "release"] {
            let candidate = dir.join(profile).join(&file_name);
            if is_runnable(&candidate) {
                return candidate;
            }
        }
    }
    which::which(&file_name)
        .ok()
        .filter(|path| is_runnable(path))
        .unwrap_or_else(|| PathBuf::from(file_name))
}

fn env_override(base: &str) -> Option<PathBuf> {
    let key = match base {
        "vibex-mcp" => "VIBEX_MCP_BIN",
        "vibex-workflow-mcp" => "VIBEX_WORKFLOW_MCP_BIN",
        _ => return None,
    };
    std::env::var_os(key).map(PathBuf::from)
}

fn binary_file_name(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

fn is_runnable(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.len() > 0)
}

fn search_from(exe: &Path, base: &str, file_name: &str) -> Option<PathBuf> {
    let mut dir = exe.parent()?;
    for _ in 0..16 {
        if let Some(found) = first_runnable_in(dir, base, file_name) {
            return Some(found);
        }
        for profile in ["debug", "release"] {
            if let Some(found) = first_runnable_in(&dir.join(profile), base, file_name) {
                return Some(found);
            }
        }
        if let Some(found) = first_runnable_in(&dir.join("binaries"), base, file_name) {
            return Some(found);
        }
        dir = dir.parent()?;
    }
    None
}

fn first_runnable_in(dir: &Path, base: &str, file_name: &str) -> Option<PathBuf> {
    let exact = dir.join(file_name);
    if is_runnable(&exact) {
        return Some(exact);
    }
    let prefix = format!("{base}-");
    let mut matches = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return None;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let matches_name = name == file_name || name.starts_with(&prefix);
        if matches_name && is_runnable(&entry.path()) {
            matches.push(entry.path());
        }
    }
    matches.into_iter().next()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_stub_is_not_runnable() {
        let dir = tempfile::tempdir().unwrap();
        let stub = dir.path().join("vibex-mcp");
        fs::write(&stub, []).unwrap();
        assert!(!is_runnable(&stub));
        fs::write(&stub, b"mcp").unwrap();
        assert!(is_runnable(&stub));
    }

    #[test]
    fn search_skips_empty_sidecar_and_finds_profile_binary() {
        let root = tempfile::tempdir().unwrap();
        let macos = root
            .path()
            .join("cef-runtime/macos/app/vibex.app/Contents/MacOS");
        fs::create_dir_all(&macos).unwrap();
        fs::write(macos.join("vibex"), b"app").unwrap();
        fs::write(macos.join("vibex-mcp"), []).unwrap();
        let debug = root.path().join("debug");
        fs::create_dir_all(&debug).unwrap();
        let real = debug.join("vibex-mcp");
        fs::write(&real, b"real-mcp").unwrap();

        let found = search_from(&macos.join("vibex"), "vibex-mcp", "vibex-mcp").unwrap();
        assert_eq!(found, real);
    }

    #[test]
    fn search_accepts_target_triple_sidecar_name() {
        let dir = tempfile::tempdir().unwrap();
        let sidecar = dir.path().join("vibex-mcp-aarch64-apple-darwin");
        fs::write(&sidecar, b"sidecar").unwrap();
        let found = first_runnable_in(dir.path(), "vibex-mcp", "vibex-mcp").unwrap();
        assert_eq!(found, sidecar);
    }
}
