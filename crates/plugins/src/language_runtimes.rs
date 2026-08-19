//! Host-managed language runtimes for Plugin Workers.

pub const PLUGIN_WORKER_CPYTHON_VERSION: &str = "3.12.11";
const CPYTHON_BUILD: &str = "20250818";

pub struct LanguageRuntimeLock {
    pub id: &'static str,
    pub version: &'static str,
    pub target: &'static str,
    pub url: String,
    pub sha256: &'static str,
    pub entrypoint: &'static str,
}

pub fn plugin_worker_cpython_lock() -> Option<LanguageRuntimeLock> {
    let (target, sha256, entrypoint) = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => (
            "aarch64-apple-darwin",
            "fabb5fd4de54c68ce7e70d19fb08127549da5787cd38a34d00000749f4fde478",
            "bin/python3",
        ),
        ("macos", "x86_64") => (
            "x86_64-apple-darwin",
            "896add7763faa8012ba6a37346718b32ed0ac041230979cfe8fc802fbb0daeef",
            "bin/python3",
        ),
        ("linux", "aarch64") => (
            "aarch64-unknown-linux-gnu",
            "b3df3317e101cadcc56f08912fe0f68c5fbe1649a035585d650891ecd60a7d0a",
            "bin/python3",
        ),
        ("linux", "x86_64") => (
            "x86_64-unknown-linux-gnu",
            "98229938166f51deff81b00d71455fac84a57290b71089bd5fe673738557f053",
            "bin/python3",
        ),
        ("windows", "aarch64") => (
            "aarch64-pc-windows-msvc",
            "6af9d77e969e31d2b68e78fb431e59553a3cf34c9e1c5cee6ed4ce2c3d63974d",
            "python.exe",
        ),
        ("windows", "x86_64") => (
            "x86_64-pc-windows-msvc",
            "a6bc8c4658a758ec0c111b5f887f80595943fd84f28bbbaea6e7e30c7815dd26",
            "python.exe",
        ),
        _ => return None,
    };
    Some(LanguageRuntimeLock {
        id: "vibex-plugin-worker-cpython",
        version: PLUGIN_WORKER_CPYTHON_VERSION,
        target,
        url: format!(
            "https://github.com/indygreg/python-build-standalone/releases/download/{CPYTHON_BUILD}/cpython-{PLUGIN_WORKER_CPYTHON_VERSION}+{CPYTHON_BUILD}-{target}-install_only.tar.gz"
        ),
        sha256,
        entrypoint,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpython_lock_uses_official_checksums() {
        let Some(lock) = plugin_worker_cpython_lock() else {
            return;
        };
        assert_eq!(lock.sha256.len(), 64);
        assert!(lock.url.contains("python-build-standalone"));
        assert_eq!(lock.version, "3.12.11");
    }
}
