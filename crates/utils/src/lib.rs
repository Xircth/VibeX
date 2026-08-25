use std::sync::OnceLock;

use directories::ProjectDirs;

pub mod approvals;
pub mod assets;
pub mod browser;
pub mod diff;
pub mod host_bin;
pub mod log_msg;
pub mod msg_store;
pub mod net;
pub mod path;
pub mod port_file;
pub mod process;
pub mod proxy;
pub mod shell;
pub mod stream_lines;
pub mod text;
pub mod tokio;
pub mod tunnel;
pub mod version;

/// Cache for WSL2 detection result
static WSL2_CACHE: OnceLock<bool> = OnceLock::new();

/// Check if running in WSL2 (cached)
pub fn is_wsl2() -> bool {
    *WSL2_CACHE.get_or_init(|| {
        // Check for WSL environment variables
        if std::env::var("WSL_DISTRO_NAME").is_ok() || std::env::var("WSLENV").is_ok() {
            tracing::debug!("WSL2 detected via environment variables");
            return true;
        }

        // Check /proc/version for WSL2 signature
        if let Ok(version) = std::fs::read_to_string("/proc/version")
            && (version.contains("WSL2") || version.contains("microsoft"))
        {
            tracing::debug!("WSL2 detected via /proc/version");
            return true;
        }

        tracing::debug!("WSL2 not detected");
        false
    })
}

pub fn cache_dir() -> std::path::PathBuf {
    ProjectDirs::from("app", "vibex", "vibex")
        .expect("OS didn't give us a home directory")
        .cache_dir()
        .to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::cache_dir;

    #[test]
    fn cache_dir_uses_the_vibex_project_identity() {
        let path = cache_dir();
        let rendered = path.to_string_lossy();
        assert!(
            rendered.to_ascii_lowercase().contains("vibex"),
            "cache directory should belong to VibeX, got {rendered}"
        );
        assert!(
            !rendered.to_ascii_lowercase().contains("bloop"),
            "cache directory still uses the leftover bloop identity: {rendered}"
        );
    }
}
