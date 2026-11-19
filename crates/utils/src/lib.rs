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

pub const DEFAULT_SITE_ORIGIN: &str = "https://dimo-ai.com";
/// Previous public site. Installed marketplace sources and saved tunnel
/// origins on this host stay valid; new defaults use `DEFAULT_SITE_ORIGIN`.
pub const LEGACY_SITE_ORIGIN: &str = "https://vibex.xforever.xin";
pub const DEFAULT_DEV_SITE_ORIGIN: &str = "http://localhost:3100";

fn default_site_origin() -> &'static str {
    if cfg!(all(debug_assertions, not(test))) {
        DEFAULT_DEV_SITE_ORIGIN
    } else {
        DEFAULT_SITE_ORIGIN
    }
}

pub fn site_origin() -> String {
    std::env::var("DIMO_SITE_URL")
        .ok()
        .or_else(|| option_env!("DIMO_SITE_URL").map(str::to_owned))
        .map(|value| value.trim().trim_end_matches('/').to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| default_site_origin().to_owned())
}

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
    ProjectDirs::from("app", "dimo", "dimo")
        .expect("OS didn't give us a home directory")
        .cache_dir()
        .to_path_buf()
}

#[cfg(test)]
pub(crate) fn lock_site_env() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().expect("site env lock")
}

#[cfg(test)]
mod tests {
    use super::{DEFAULT_SITE_ORIGIN, cache_dir, lock_site_env, site_origin};

    #[test]
    fn cache_dir_uses_the_dimo_project_identity() {
        let path = cache_dir();
        let rendered = path.to_string_lossy();
        assert!(
            rendered.to_ascii_lowercase().contains("dimo"),
            "cache directory should belong to Dimo, got {rendered}"
        );
        assert!(
            !rendered.to_ascii_lowercase().contains("bloop"),
            "cache directory still uses the leftover bloop identity: {rendered}"
        );
    }

    #[test]
    fn site_origin_defaults_to_the_public_site_and_keeps_an_env_override() {
        let _lock = lock_site_env();
        let previous = std::env::var("DIMO_SITE_URL").ok();
        unsafe {
            std::env::remove_var("DIMO_SITE_URL");
        }
        let default_origin = site_origin();
        unsafe {
            std::env::set_var("DIMO_SITE_URL", "https://site.example.test/");
        }
        let overridden = site_origin();
        unsafe {
            match previous {
                Some(value) => std::env::set_var("DIMO_SITE_URL", value),
                None => std::env::remove_var("DIMO_SITE_URL"),
            }
        }
        assert_eq!(default_origin, DEFAULT_SITE_ORIGIN);
        assert_eq!(overridden, "https://site.example.test");
    }
}
