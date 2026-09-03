use std::{
    io,
    path::{Path, PathBuf},
    time::Duration,
};

/// Directory name for storing images in worktrees
pub const VIBE_IMAGES_DIR: &str = ".vibe-images";

/// Directories that should always be skipped regardless of gitignore.
/// .git is not in .gitignore but should never be watched.
pub const ALWAYS_SKIP_DIRS: &[&str] = &[".git", "node_modules"];

/// Returns the root for Host-managed bootstrap toolchains (Node, uv).
///
/// This is a user-owned directory, not Tauri app data. Agent Runtime and ACP
/// are installed into the user environment (`~/.local/bin`, npm prefix, uv
/// tools). Clearing VibeX application data must not remove those CLIs or the
/// Node/uv used to write them. On macOS, keeping executables out of
/// `~/Library/Application Support` also avoids dyld treating an ancestor as an
/// application bundle.
pub fn managed_artifacts_directory(home_dir: &Path, _app_data_dir: &Path) -> PathBuf {
    home_dir.join(".local").join("share").join("vibex")
}

/// Convert absolute paths to relative paths based on worktree path
/// This is a robust implementation that handles symlinks and edge cases
pub fn make_path_relative(path: &str, worktree_path: &str) -> String {
    tracing::trace!("Making path relative: {} -> {}", path, worktree_path);

    let path_obj = normalize_macos_private_alias(Path::new(&path));
    let worktree_path_obj = normalize_macos_private_alias(Path::new(worktree_path));

    // If path is already relative, return as is
    if path_obj.is_relative() {
        return path.to_string();
    }

    if let Ok(relative_path) = path_obj.strip_prefix(&worktree_path_obj) {
        let result = relative_path.to_string_lossy().to_string();
        tracing::trace!("Successfully made relative: '{}' -> '{}'", path, result);
        if result.is_empty() {
            return ".".to_string();
        }
        return result;
    }

    if !path_obj.exists() || !worktree_path_obj.exists() {
        return path.to_string();
    }

    // canonicalize may fail if paths don't exist
    let canonical_path = std::fs::canonicalize(&path_obj);
    let canonical_worktree = std::fs::canonicalize(&worktree_path_obj);

    match (canonical_path, canonical_worktree) {
        (Ok(canon_path), Ok(canon_worktree)) => {
            tracing::debug!(
                "Trying canonical path resolution: '{}' -> '{}', '{}' -> '{}'",
                path,
                canon_path.display(),
                worktree_path,
                canon_worktree.display()
            );

            match canon_path.strip_prefix(&canon_worktree) {
                Ok(relative_path) => {
                    let result = relative_path.to_string_lossy().to_string();
                    tracing::debug!(
                        "Successfully made relative with canonical paths: '{}' -> '{}'",
                        path,
                        result
                    );
                    if result.is_empty() {
                        return ".".to_string();
                    }
                    result
                }
                Err(e) => {
                    tracing::debug!(
                        "Failed to make canonical path relative: '{}' relative to '{}', error: {}, returning original",
                        canon_path.display(),
                        canon_worktree.display(),
                        e
                    );
                    path.to_string()
                }
            }
        }
        _ => {
            tracing::debug!(
                "Could not canonicalize paths (paths may not exist): '{}', '{}', returning original",
                path,
                worktree_path
            );
            path.to_string()
        }
    }
}

/// Normalize macOS prefix /private/var/ and /private/tmp/ to their public aliases without resolving paths.
/// This allows prefix normalization to work when the full paths don't exist.
pub fn normalize_macos_private_alias<P: AsRef<Path>>(p: P) -> PathBuf {
    let p = p.as_ref();
    if cfg!(target_os = "macos")
        && let Some(s) = p.to_str()
    {
        if s == "/private/var" {
            return PathBuf::from("/var");
        }
        if let Some(rest) = s.strip_prefix("/private/var/") {
            return PathBuf::from(format!("/var/{rest}"));
        }
        if s == "/private/tmp" {
            return PathBuf::from("/tmp");
        }
        if let Some(rest) = s.strip_prefix("/private/tmp/") {
            return PathBuf::from(format!("/tmp/{rest}"));
        }
    }
    p.to_path_buf()
}

/// Strip Windows verbatim path prefixes (for example `\\?\C:\...`) so paths
/// remain readable in the UI and spawnable by `cmd.exe` / Node while keeping
/// the same filesystem target. Applied on every host so stored Windows paths
/// can be normalized in tests and at launch.
pub fn normalize_windows_extended_path_prefix<P: AsRef<Path>>(path: P) -> PathBuf {
    let path = path.as_ref();
    let raw = path.to_string_lossy();
    if let Some(rest) = raw.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = raw.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    if let Some(rest) = raw.strip_prefix(r"\?\") {
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

pub fn get_vibex_temp_dir() -> std::path::PathBuf {
    let dir_name = if cfg!(debug_assertions) {
        "vibex-dev"
    } else {
        "vibex"
    };

    let mut candidates = Vec::new();
    if cfg!(target_os = "linux") {
        // Prefer /var/tmp over tmpfs /tmp when the location is writable.
        candidates.push(std::path::PathBuf::from("/var/tmp").join(dir_name));
    }
    candidates.push(std::env::temp_dir().join(dir_name));

    for path in candidates {
        if directory_is_writable(&path) {
            return path;
        }
    }

    std::env::temp_dir().join(dir_name)
}

fn directory_is_writable(path: &Path) -> bool {
    if std::fs::create_dir_all(path).is_err() {
        return false;
    }
    let probe = path.join(format!(".vibex-write-{}", std::process::id()));
    match std::fs::write(&probe, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// Windows ERROR_SHARING_VIOLATION: a live process, indexer, or antivirus still
/// holds a handle. Unix equivalents are retried too so cleanup is uniform.
pub fn is_retryable_remove_error(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::PermissionDenied | io::ErrorKind::DirectoryNotEmpty
    ) || error.raw_os_error() == Some(32)
        || error.raw_os_error() == Some(5)
}

/// Remove a directory tree, retrying transient sharing/lock failures.
///
/// `NotFound` is success. Exhausted retries return the last error so callers
/// can log it; capability probes must not treat that as a catalog load failure.
pub async fn remove_dir_all_retrying(path: &Path) -> io::Result<()> {
    const ATTEMPTS: u32 = 8;
    let mut last_error = None;
    for attempt in 0..ATTEMPTS {
        match tokio::fs::remove_dir_all(path).await {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) if is_retryable_remove_error(&error) && attempt + 1 < ATTEMPTS => {
                last_error = Some(error);
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            Err(error) => return Err(error),
        }
    }
    Err(last_error.unwrap_or_else(|| io::Error::other("directory remove retries exhausted")))
}

/// Expand leading `~`, `~/`, or `~\` to the user's home directory.
pub fn expand_tilde(path_str: &str) -> std::path::PathBuf {
    let rest = path_str
        .strip_prefix("~/")
        .or_else(|| path_str.strip_prefix("~\\"))
        .or_else(|| (path_str == "~").then_some(""));
    if let Some(rest) = rest
        && let Some(home) = dirs::home_dir()
    {
        let mut path = home;
        for component in rest
            .split(['/', '\\'])
            .filter(|component| !component.is_empty())
        {
            path.push(component);
        }
        return path;
    }
    PathBuf::from(path_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_make_path_relative() {
        // Test with relative path (should remain unchanged)
        assert_eq!(
            make_path_relative("src/main.rs", "/tmp/test-worktree"),
            "src/main.rs"
        );

        // Test with absolute path (should become relative if possible)
        let test_worktree = std::env::temp_dir().join("test-worktree");
        let absolute_path = test_worktree.join("src").join("main.rs");
        let result = make_path_relative(
            &absolute_path.to_string_lossy(),
            &test_worktree.to_string_lossy(),
        );
        assert_eq!(
            result,
            std::path::PathBuf::from("src")
                .join("main.rs")
                .to_string_lossy()
        );

        // Test with path outside worktree (should return original)
        let outside_path = std::env::temp_dir().join("other").join("file.js");
        assert_eq!(
            make_path_relative(
                &outside_path.to_string_lossy(),
                &test_worktree.to_string_lossy()
            ),
            outside_path.to_string_lossy()
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn test_make_path_relative_macos_private_alias() {
        // Simulate a worktree under /var with a path reported under /private/var
        let worktree = "/var/folders/zz/abc123/T/vibex-dev/worktrees/vk-test";
        let path_under_private = format!(
            "/private/var{}/hello-world.txt",
            worktree.strip_prefix("/var").unwrap()
        );
        assert_eq!(
            make_path_relative(&path_under_private, worktree),
            "hello-world.txt"
        );

        // Also handle the inverse: worktree under /private and path under /var
        let worktree_private = format!("/private{worktree}");
        let path_under_var = format!("{worktree}/hello-world.txt");
        assert_eq!(
            make_path_relative(&path_under_var, &worktree_private),
            "hello-world.txt"
        );
    }

    #[test]
    fn normalize_windows_extended_path_prefix_preserves_regular_paths() {
        let path = PathBuf::from(r"C:\Users\Administrator\Documents\Projects");
        assert_eq!(normalize_windows_extended_path_prefix(&path), path);
    }

    #[test]
    fn normalize_windows_extended_path_prefix_strips_drive_prefix() {
        let normalized =
            normalize_windows_extended_path_prefix(PathBuf::from(r"\\?\C:\Users\Admin"));
        assert_eq!(normalized, PathBuf::from(r"C:\Users\Admin"));
    }

    #[test]
    fn normalize_windows_extended_path_prefix_strips_unc_prefix() {
        let normalized = normalize_windows_extended_path_prefix(PathBuf::from(
            r"\\?\UNC\server\share\workspace",
        ));
        assert_eq!(normalized, PathBuf::from(r"\\server\share\workspace"));
    }

    #[test]
    fn managed_artifacts_avoid_macos_app_bundle_data_directories() {
        let home = Path::new("/Users/developer");
        let app_data = home.join("Library/Application Support/com.vibex.app");
        let root = managed_artifacts_directory(home, &app_data);

        assert_eq!(root, home.join(".local/share/vibex"));
        assert_ne!(root, app_data);
    }

    #[test]
    fn expand_tilde_accepts_posix_and_windows_home_prefixes() {
        let home = dirs::home_dir().expect("home");
        assert_eq!(expand_tilde("~"), home);
        assert_eq!(expand_tilde("~/Projects"), home.join("Projects"));
        assert_eq!(expand_tilde("~\\Projects"), home.join("Projects"));
        assert_eq!(
            expand_tilde("~\\.codex\\auth.json"),
            home.join(".codex").join("auth.json")
        );
        assert_eq!(
            expand_tilde("relative/path"),
            PathBuf::from("relative/path")
        );
    }

    #[test]
    fn vibex_temp_dir_is_writable_on_the_current_platform() {
        let path = get_vibex_temp_dir();
        let probe = path.join(format!("probe-{}", std::process::id()));
        std::fs::write(&probe, b"ok").expect("temp directory must be writable");
        let _ = std::fs::remove_file(&probe);
        #[cfg(target_os = "linux")]
        assert!(
            path.starts_with("/var/tmp") || path.starts_with(std::env::temp_dir()),
            "linux temp dir should use /var/tmp or the process temp dir, got {}",
            path.display()
        );
    }

    #[test]
    fn sharing_violation_is_retryable_for_probe_cleanup() {
        assert!(is_retryable_remove_error(
            &std::io::Error::from_raw_os_error(32)
        ));
        assert!(is_retryable_remove_error(
            &std::io::Error::from_raw_os_error(5)
        ));
        assert!(is_retryable_remove_error(&std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "locked"
        )));
        assert!(!is_retryable_remove_error(&std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "bad path"
        )));
    }

    #[tokio::test]
    async fn remove_dir_all_retrying_treats_missing_and_present_dirs_as_success() {
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("already-gone");
        remove_dir_all_retrying(&missing).await.unwrap();

        let present = root.path().join("probe");
        std::fs::create_dir_all(present.join("nested")).unwrap();
        std::fs::write(present.join("nested/file.txt"), b"ok").unwrap();
        remove_dir_all_retrying(&present).await.unwrap();
        assert!(!present.exists());
    }
}
