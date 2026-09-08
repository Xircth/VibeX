//! Shared bootstrap toolchain metadata for Agent installs (ADR-0060).
//!
//! Node and uv are not Agent installation artifacts. They are the tools used
//! to write official Agent CLIs into the user environment. Desktop and
//! `vibex-server` must use the same pinned versions and checksums so a Host
//! without a system Node can still install ACP.

pub const MANAGED_NODE_VERSION: &str = "22.22.3";
pub const MANAGED_UV_VERSION: &str = "0.8.10";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ManagedNodeArtifact {
    pub target: &'static str,
    pub extension: &'static str,
    pub sha256: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ManagedUvArtifact {
    pub target: &'static str,
    pub extension: &'static str,
    pub sha256: &'static str,
}

pub fn managed_node_artifact(platform: &str) -> Option<ManagedNodeArtifact> {
    let (target, extension, sha256) = match platform {
        "darwin-aarch64" => (
            "darwin-arm64",
            "tar.gz",
            "0da7ff74ef8611328c8212f17943368713a2ad953fb7d89a8c8a0eae87c23207",
        ),
        "darwin-x86_64" => (
            "darwin-x64",
            "tar.gz",
            "45830ba752fa0d892c6dcd640946669801293cac820a33591ded40ac075198ec",
        ),
        "linux-aarch64" => (
            "linux-arm64",
            "tar.gz",
            "cc8bc82b2dd0b595c3b95a4c3c9c8c350907cff011afbdee3d1379e812e1e3e3",
        ),
        "linux-x86_64" => (
            "linux-x64",
            "tar.gz",
            "c7a10d6816da8eaaa7534dd73c71c6e2b2c391dbbf845e364902d156615dd1b8",
        ),
        "windows-aarch64" => (
            "win-arm64",
            "zip",
            "00be129a09e8872cd52d3bb8bba12412c5733d2224123a482a2dca4a6fbf2586",
        ),
        "windows-x86_64" => (
            "win-x64",
            "zip",
            "6c8d54f635feff4df76c2ca80f45332eb2ff57d25226edce36592e51a177ee33",
        ),
        _ => return None,
    };
    Some(ManagedNodeArtifact {
        target,
        extension,
        sha256,
    })
}

pub fn managed_node_archive_name(artifact: &ManagedNodeArtifact) -> String {
    format!(
        "node-v{MANAGED_NODE_VERSION}-{}.{}",
        artifact.target, artifact.extension
    )
}

/// Official Node.js dist plus mirrors. Host ACP install downloads these on the
/// Host itself (a connected App cannot upload through SSH).
pub fn managed_node_download_urls(artifact: &ManagedNodeArtifact) -> Vec<String> {
    let name = managed_node_archive_name(artifact);
    vec![
        format!("https://nodejs.org/dist/v{MANAGED_NODE_VERSION}/{name}"),
        format!("https://npmmirror.com/mirrors/node/v{MANAGED_NODE_VERSION}/{name}"),
        format!("https://cdn.npmmirror.com/binaries/node/v{MANAGED_NODE_VERSION}/{name}"),
    ]
}

pub fn managed_uv_artifact(platform: &str) -> Option<ManagedUvArtifact> {
    let (target, extension, sha256) = match platform {
        "darwin-aarch64" => (
            "aarch64-apple-darwin",
            "tar.gz",
            "5200278ae00b5c0822a7db7a99376b2167e8e9391b29c3de22f9e4fdebc9c0e8",
        ),
        "darwin-x86_64" => (
            "x86_64-apple-darwin",
            "tar.gz",
            "3b935381af9124a5d5da48235e149f5f0662f2717e75782d1b843d39d9265d6d",
        ),
        "linux-aarch64" => (
            "aarch64-unknown-linux-gnu",
            "tar.gz",
            "de60f5e3d69b54e6196fb8937fef4feb15e239f0fd14278e77e44dbb353214ae",
        ),
        "linux-x86_64" => (
            "x86_64-unknown-linux-gnu",
            "tar.gz",
            "2c4392591fe9469d006452ef22f32712f35087d87fb1764ec03e23544eb8770d",
        ),
        "windows-aarch64" => (
            "aarch64-pc-windows-msvc",
            "zip",
            "c51b02188c312baef71187273afa625576101e5680739eab83b1b09ca5d2f3a8",
        ),
        "windows-x86_64" => (
            "x86_64-pc-windows-msvc",
            "zip",
            "37fcd011fd22b2a569f7e583a924af2d624d99445f669752923a2fd3841f8e3d",
        ),
        _ => return None,
    };
    Some(ManagedUvArtifact {
        target,
        extension,
        sha256,
    })
}

/// Npx plans are installable when a system Node exists **or** VibeX can
/// bootstrap the pinned Node distribution for this platform.
pub fn node_verified_for_install(system_node_and_npm: bool, platform: &str) -> bool {
    system_node_and_npm || managed_node_artifact(platform).is_some()
}

/// Uvx plans are installable when a system uv exists **or** VibeX can
/// bootstrap the pinned uv distribution for this platform.
pub fn uv_verified_for_install(system_uv: bool, platform: &str) -> bool {
    system_uv || managed_uv_artifact(platform).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn npx_plans_do_not_require_a_system_node_on_supported_hosts() {
        assert!(node_verified_for_install(false, "linux-x86_64"));
        assert!(node_verified_for_install(false, "linux-aarch64"));
        assert!(node_verified_for_install(false, "darwin-aarch64"));
        assert!(node_verified_for_install(false, "windows-x86_64"));
        assert!(!node_verified_for_install(false, "unknown-os"));
        assert!(node_verified_for_install(true, "unknown-os"));
    }

    #[test]
    fn uvx_plans_do_not_require_a_system_uv_on_supported_hosts() {
        assert!(uv_verified_for_install(false, "linux-x86_64"));
        assert!(!uv_verified_for_install(false, "unknown-os"));
    }

    #[test]
    fn managed_node_artifact_matches_the_pinned_dist_url() {
        let artifact = managed_node_artifact("linux-x86_64").expect("linux node");
        assert_eq!(artifact.target, "linux-x64");
        assert_eq!(artifact.extension, "tar.gz");
        assert_eq!(artifact.sha256.len(), 64);
        let urls = managed_node_download_urls(&artifact);
        assert_eq!(
            urls[0],
            format!(
                "https://nodejs.org/dist/v{MANAGED_NODE_VERSION}/node-v{MANAGED_NODE_VERSION}-linux-x64.tar.gz"
            )
        );
        assert!(
            urls.iter().any(|url| url.contains("npmmirror.com")),
            "Host bootstrap must not depend on a single Node.js origin"
        );
    }
}
