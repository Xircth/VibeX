//! Locate Host-family sidecar binaries (`dimo-mcp`, `dimo-workflow-mcp`).
//!
//! Binaries resolved out of a Cargo build tree (`target/debug`, `target/release`,
//! `CARGO_TARGET_DIR`, or `src-tauri/binaries`) are staged into a stable
//! user-owned runtime directory (`~/.local/share/dimo/host-bin`) before being
//! handed to ACP session injection or native CLI projections. This keeps running
//! MCP child processes from locking Cargo's `target/` outputs on Windows and
//! keeps projected CLI configs valid across `cargo clean` and worktree removal.

use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

static NEXT_STAGE_SEQ: AtomicU64 = AtomicU64::new(1);

/// Resolve a Host-family sidecar, skipping empty Tauri stubs.
///
/// Order: `DIMO_MCP_BIN` / `DIMO_WORKFLOW_MCP_BIN` → current-exe directory
/// and ancestors (including `debug`/`release`/`binaries`) → `CARGO_TARGET_DIR`
/// → `PATH` → previously staged `~/.local/share/dimo/host-bin` copy (for known
/// Host-family sidecars when the build tree was cleaned). Empty files are never
/// returned.
///
/// When nothing runnable exists this still returns the basename so log lines
/// have a name. Injection and native projection must use
/// [`locate_runnable_host_family_binary`] instead — a basename is not a command.
pub fn locate_host_family_binary(base: &str) -> PathBuf {
    locate_runnable_host_family_binary(base)
        .unwrap_or_else(|| PathBuf::from(binary_file_name(base)))
}

/// Like [`locate_host_family_binary`], but `None` when no non-empty file exists.
pub fn locate_runnable_host_family_binary(base: &str) -> Option<PathBuf> {
    let file_name = binary_file_name(base);
    let explicit_override = env_override(base);

    if let Some(source) =
        locate_raw_host_family_binary(base, &file_name, explicit_override.as_deref())
    {
        if is_build_tree_binary(&source)
            && let Some(stage_dir) = runtime_host_bin_dir()
        {
            match stage_binary_into_dir(&source, &stage_dir, &file_name) {
                Ok(staged) => return Some(staged),
                Err(error) => {
                    tracing::warn!(
                        %error,
                        source = %source.display(),
                        stage_dir = %stage_dir.display(),
                        "failed to stage host-family binary; falling back to build-tree path"
                    );
                }
            }
        }
        return Some(crate::path::normalize_windows_extended_path_prefix(source));
    }

    // If Cargo's `target/` tree was cleaned before rebuilding sidecars, reuse
    // the last staged copy unless the caller explicitly pinned a custom
    // non-build-tree path via `DIMO_*_BIN`.
    if is_known_host_family_binary(base)
        && explicit_override
            .as_deref()
            .is_none_or(is_build_tree_binary)
        && let Some(staged) = runtime_host_bin_dir().map(|dir| dir.join(&file_name))
        && is_runnable(&staged)
    {
        return Some(staged);
    }

    None
}

fn is_known_host_family_binary(base: &str) -> bool {
    matches!(base, "dimo-mcp" | "dimo-workflow-mcp")
}

fn locate_raw_host_family_binary(
    base: &str,
    file_name: &str,
    explicit_override: Option<&Path>,
) -> Option<PathBuf> {
    if let Some(path) = explicit_override.filter(|path| is_runnable(path)) {
        return Some(path.to_path_buf());
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(found) = search_from(&exe, base, file_name)
    {
        return Some(found);
    }
    if let Ok(target) = std::env::var("CARGO_TARGET_DIR") {
        let dir = PathBuf::from(target);
        for profile in ["debug", "release"] {
            let candidate = dir.join(profile).join(file_name);
            if is_runnable(&candidate) {
                return Some(candidate);
            }
        }
    }
    which::which(file_name)
        .ok()
        .filter(|path| is_runnable(path))
}

fn runtime_host_bin_dir() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let dir = crate::path::managed_artifacts_directory(&home, &home).join("host-bin");
    Some(crate::path::normalize_windows_extended_path_prefix(dir))
}

fn is_build_tree_binary(path: &Path) -> bool {
    if let Some(cargo_target) = std::env::var_os("CARGO_TARGET_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        && path.starts_with(&cargo_target)
    {
        return true;
    }

    let components: Vec<String> = path
        .parent()
        .into_iter()
        .flat_map(Path::components)
        .map(|component| component.as_os_str().to_string_lossy().to_ascii_lowercase())
        .collect();

    if matches!(
        components.last().map(String::as_str),
        Some("debug" | "release" | "deps")
    ) {
        return true;
    }

    for window in components.windows(2) {
        if (window[0] == "target" && matches!(window[1].as_str(), "debug" | "release"))
            || (window[0] == "src-tauri" && window[1] == "binaries")
        {
            return true;
        }
    }

    for window in components.windows(3) {
        if window[0] == "target" && matches!(window[2].as_str(), "debug" | "release") {
            return true;
        }
    }

    false
}

fn stage_binary_into_dir(source: &Path, stage_dir: &Path, file_name: &str) -> io::Result<PathBuf> {
    fs::create_dir_all(stage_dir)?;
    sweep_retired_binaries(stage_dir, file_name);

    let destination =
        crate::path::normalize_windows_extended_path_prefix(stage_dir.join(file_name));
    if staged_matches_source(&destination, source) {
        return Ok(destination);
    }

    let source_meta = fs::metadata(source)?;
    let seq = NEXT_STAGE_SEQ.fetch_add(1, Ordering::Relaxed);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let tmp = stage_dir.join(format!(
        "{file_name}.tmp-{}-{stamp}-{seq}",
        std::process::id()
    ));

    fs::copy(source, &tmp)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(&tmp) {
            let mut perms = meta.permissions();
            perms.set_mode(0o755);
            let _ = fs::set_permissions(&tmp, perms);
        }
    }
    if let Ok(source_mtime) = source_meta.modified()
        && let Ok(file) = fs::OpenOptions::new().write(true).open(&tmp)
    {
        let _ = file.set_modified(source_mtime);
    }

    if let Err(first_error) = fs::rename(&tmp, &destination) {
        if destination.exists() {
            let retired = stage_dir.join(format!(
                "{file_name}.old-{}-{stamp}-{seq}",
                std::process::id()
            ));
            let _ = fs::rename(&destination, &retired);
            if let Err(retry_error) = fs::rename(&tmp, &destination) {
                let _ = fs::remove_file(&tmp);
                if is_runnable(&destination) {
                    return Ok(destination);
                }
                return Err(retry_error);
            }
        } else {
            let _ = fs::remove_file(&tmp);
            return Err(first_error);
        }
    }

    Ok(destination)
}

fn staged_matches_source(staged: &Path, source: &Path) -> bool {
    let (Ok(staged_meta), Ok(source_meta)) = (fs::metadata(staged), fs::metadata(source)) else {
        return false;
    };
    if !staged_meta.is_file() || staged_meta.len() == 0 || staged_meta.len() != source_meta.len() {
        return false;
    }
    let (Ok(staged_mtime), Ok(source_mtime)) = (staged_meta.modified(), source_meta.modified())
    else {
        return false;
    };
    let delta = match staged_mtime.duration_since(source_mtime) {
        Ok(diff) => diff,
        Err(err) => err.duration(),
    };
    delta <= Duration::from_millis(10)
}

fn sweep_retired_binaries(stage_dir: &Path, file_name: &str) {
    let old_prefix = format!("{file_name}.old-");
    let Ok(entries) = fs::read_dir(stage_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(&old_prefix) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn env_override(base: &str) -> Option<PathBuf> {
    let key = match base {
        "dimo-mcp" => "DIMO_MCP_BIN",
        "dimo-workflow-mcp" => "DIMO_WORKFLOW_MCP_BIN",
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
        let stub = dir.path().join("dimo-mcp");
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
            .join("bundle/macos/app/dimo.app/Contents/MacOS");
        fs::create_dir_all(&macos).unwrap();
        fs::write(macos.join("dimo"), b"app").unwrap();
        fs::write(macos.join("dimo-mcp"), []).unwrap();
        let debug = root.path().join("debug");
        fs::create_dir_all(&debug).unwrap();
        let real = debug.join("dimo-mcp");
        fs::write(&real, b"real-mcp").unwrap();

        let found = search_from(&macos.join("dimo"), "dimo-mcp", "dimo-mcp").unwrap();
        assert_eq!(found, real);
    }

    #[test]
    fn runnable_locator_does_not_return_a_path_basename() {
        assert!(locate_runnable_host_family_binary("dimo-mcp-missing-binary").is_none());
        let fallback = locate_host_family_binary("dimo-mcp-missing-binary");
        assert_eq!(
            fallback.file_name().and_then(|name| name.to_str()),
            Some(binary_file_name("dimo-mcp-missing-binary").as_str())
        );
        assert!(!fallback.is_absolute() || !is_runnable(&fallback));
    }

    #[test]
    fn search_accepts_target_triple_sidecar_name() {
        let dir = tempfile::tempdir().unwrap();
        let sidecar = dir.path().join("dimo-mcp-aarch64-apple-darwin");
        fs::write(&sidecar, b"sidecar").unwrap();
        let found = first_runnable_in(dir.path(), "dimo-mcp", "dimo-mcp").unwrap();
        assert_eq!(found, sidecar);
    }

    #[test]
    fn build_tree_detection_distinguishes_cargo_outputs_from_installs() {
        assert!(is_build_tree_binary(Path::new(
            "/repo/target/debug/dimo-mcp"
        )));
        assert!(is_build_tree_binary(Path::new(
            "/repo/target/release/dimo-mcp.exe"
        )));
        assert!(is_build_tree_binary(Path::new(
            "/repo/target/x86_64-pc-windows-msvc/debug/dimo-mcp.exe"
        )));
        assert!(is_build_tree_binary(Path::new(
            "/repo/src-tauri/binaries/dimo-mcp-x86_64-pc-windows-msvc.exe"
        )));
        assert!(is_build_tree_binary(Path::new(
            "/custom-cargo-target/debug/dimo-mcp.exe"
        )));

        assert!(!is_build_tree_binary(Path::new(
            "/Applications/Dimo.app/Contents/MacOS/dimo-mcp"
        )));
        assert!(!is_build_tree_binary(Path::new(
            r"C:\Users\alice\AppData\Local\Dimo\dimo-mcp.exe"
        )));
        assert!(!is_build_tree_binary(Path::new("/usr/local/bin/dimo-mcp")));
    }

    #[test]
    fn staging_copies_updates_and_sweeps_retired_binaries() {
        let root = tempfile::tempdir().unwrap();
        let build_dir = root.path().join("target/debug");
        let stage_dir = root.path().join("host-bin");
        fs::create_dir_all(&build_dir).unwrap();
        fs::create_dir_all(&stage_dir).unwrap();

        let file_name = binary_file_name("dimo-mcp");
        let source = build_dir.join(&file_name);
        let stale_old = stage_dir.join(format!("{file_name}.old-123-1"));
        fs::write(&stale_old, b"retired").unwrap();
        fs::write(&source, b"v1-binary").unwrap();

        let staged = stage_binary_into_dir(&source, &stage_dir, &file_name).unwrap();
        assert_eq!(fs::read(&staged).unwrap(), b"v1-binary");
        assert!(!stale_old.exists(), "unlocked retired copy should be swept");
        assert!(staged_matches_source(&staged, &source));

        fs::write(&source, b"v2-updated-binary").unwrap();
        let restaged = stage_binary_into_dir(&source, &stage_dir, &file_name).unwrap();
        assert_eq!(restaged, staged);
        assert_eq!(fs::read(&restaged).unwrap(), b"v2-updated-binary");
    }
}
