//! Shared bootstrap toolchain metadata and lazy managed Node runtime extraction (ADR-0060).
//!
//! Node and uv are not Agent installation artifacts. They are the tools used
//! to write official Agent CLIs into the user environment and to host the
//! Claude native SDK sidecar (`scripts/claude-native-driver.mjs`). Desktop and
//! `dimo-server` must use the same pinned versions, directory layout, and
//! checksums so a Host without a system Node can run both ACP installs and
//! native sidecars without cold-start extraction overhead.

use std::{
    fmt::Write as _,
    io::Cursor,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::Duration,
};

use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use uuid::Uuid;
use workspace_utils::process::{new_hidden_std_command, new_hidden_tokio_command};

pub const MANAGED_NODE_VERSION: &str = "22.22.3";
pub const MANAGED_UV_VERSION: &str = "0.8.10";
pub const MANAGED_BUN_VERSION: &str = "1.4.4";

const MAX_MANAGED_NODE_ARCHIVE_BYTES: usize = 128 * 1024 * 1024;
const NODE_DOWNLOAD_TIMEOUT_SECS: u64 = 90;
const MIN_FALLBACK_SYSTEM_NODE_MAJOR: u32 = 20;
const VERIFIED_MARKER_FILENAME: &str = ".verified";

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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ManagedBunArtifact {
    pub target: &'static str,
    pub extension: &'static str,
    pub sha256: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedNodeRuntime {
    pub node: PathBuf,
    pub npm: PathBuf,
    pub bin_dir: PathBuf,
}

#[derive(Debug, thiserror::Error)]
pub enum ManagedToolchainError {
    #[error("Managed Node.js is not supported on platform `{0}`")]
    UnsupportedPlatform(String),

    #[error("Could not resolve Dimo managed artifacts directory")]
    MissingManagedArtifactsDir,

    #[error("Managed Node.js archive exceeded maximum allowed size ({max_bytes} bytes)")]
    ArchiveTooLarge { max_bytes: usize },

    #[error("Managed Node.js archive SHA-256 mismatch: expected {expected}, found {actual}")]
    ChecksumMismatch { expected: String, actual: String },

    #[error("Failed to download managed Node.js from {urls:?}: {last_error}")]
    DownloadFailed {
        urls: Vec<String>,
        last_error: String,
    },

    #[error("Failed to extract managed Node.js archive: {0}")]
    ExtractionFailed(String),

    #[error("Managed Node.js archive did not produce expected executable `{0}`")]
    MissingExecutable(PathBuf),

    #[error("I/O error while managing Node.js toolchain: {0}")]
    Io(#[from] std::io::Error),
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
    workspace_utils::mirror::node_download_url_candidates(MANAGED_NODE_VERSION, &name)
}

pub fn managed_node_download_urls_for_proxy(
    artifact: &ManagedNodeArtifact,
    proxy_active: bool,
) -> Vec<String> {
    let name = managed_node_archive_name(artifact);
    workspace_utils::mirror::node_download_url_candidates_for_proxy(
        MANAGED_NODE_VERSION,
        &name,
        proxy_active,
    )
}

pub fn managed_uv_artifact(platform: &str) -> Option<ManagedUvArtifact> {
    managed_uv_artifact_inner(platform)
}

pub fn managed_uv_archive_name(artifact: &ManagedUvArtifact) -> String {
    format!("uv-{}.{}", artifact.target, artifact.extension)
}

pub fn managed_uv_download_urls(artifact: &ManagedUvArtifact) -> Vec<String> {
    let name = managed_uv_archive_name(artifact);
    workspace_utils::mirror::uv_download_url_candidates(MANAGED_UV_VERSION, &name)
}

pub fn managed_uv_download_urls_for_proxy(
    artifact: &ManagedUvArtifact,
    proxy_active: bool,
) -> Vec<String> {
    let name = managed_uv_archive_name(artifact);
    workspace_utils::mirror::uv_download_url_candidates_for_proxy(
        MANAGED_UV_VERSION,
        &name,
        proxy_active,
    )
}

fn managed_uv_artifact_inner(platform: &str) -> Option<ManagedUvArtifact> {
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

pub fn managed_bun_artifact(platform: &str) -> Option<ManagedBunArtifact> {
    let (target, extension, sha256) = match platform {
        "darwin-aarch64" => (
            "darwin-aarch64",
            "zip",
            "c240d7f0ccb90c263a849fcdb09b7ee62630d921348ed6aafda86b9d577bc510",
        ),
        "darwin-x86_64" => (
            "darwin-x64",
            "zip",
            "50a3491f73abc2fe81673171a85762d3bc2cc1680ccecadd983de99adf77977e",
        ),
        "linux-aarch64" => (
            "linux-aarch64",
            "zip",
            "baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e",
        ),
        "linux-x86_64" => (
            "linux-x64",
            "zip",
            "bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c",
        ),
        "windows-aarch64" => (
            "windows-aarch64",
            "zip",
            "2d57a0eec0cb44d95c918c3f9734f60455a1306ae5085d76fc68f44e3ee30d09",
        ),
        "windows-x86_64" => (
            "windows-x64",
            "zip",
            "cd2c0fccc78f3ede1f50ca827a15f063eda13d4d150a3d0674f4f6e323d864a5",
        ),
        _ => return None,
    };
    Some(ManagedBunArtifact {
        target,
        extension,
        sha256,
    })
}

pub fn managed_bun_archive_name(artifact: &ManagedBunArtifact) -> String {
    format!("bun-{}.{}", artifact.target, artifact.extension)
}

pub fn managed_bun_download_urls(artifact: &ManagedBunArtifact) -> Vec<String> {
    let name = managed_bun_archive_name(artifact);
    workspace_utils::mirror::bun_download_url_candidates(MANAGED_BUN_VERSION, &name)
}

pub fn managed_bun_download_urls_for_proxy(
    artifact: &ManagedBunArtifact,
    proxy_active: bool,
) -> Vec<String> {
    let name = managed_bun_archive_name(artifact);
    workspace_utils::mirror::bun_download_url_candidates_for_proxy(
        MANAGED_BUN_VERSION,
        &name,
        proxy_active,
    )
}

/// Npx plans are installable when a system Node exists **or** Dimo can
/// bootstrap the pinned Node distribution for this platform.
pub fn node_verified_for_install(system_node_and_npm: bool, platform: &str) -> bool {
    system_node_and_npm || managed_node_artifact(platform).is_some()
}

/// Uvx plans are installable when a system uv exists **or** Dimo can
/// bootstrap the pinned uv distribution for this platform.
pub fn uv_verified_for_install(system_uv: bool, platform: &str) -> bool {
    system_uv || managed_uv_artifact(platform).is_some()
}

/// Bun-dependent plans are installable when a system Bun exists **or** Dimo can
/// bootstrap the pinned Bun distribution for this platform.
pub fn bun_verified_for_install(system_bun: bool, platform: &str) -> bool {
    system_bun || managed_bun_artifact(platform).is_some()
}

/// Canonical platform identifier matching `crates/server/src/agent_install.rs`.
pub fn current_host_platform() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("darwin-aarch64"),
        ("macos", "x86_64") => Some("darwin-x86_64"),
        ("linux", "aarch64") => Some("linux-aarch64"),
        ("linux", "x86_64") => Some("linux-x86_64"),
        ("windows", "aarch64") => Some("windows-aarch64"),
        ("windows", "x86_64") => Some("windows-x86_64"),
        _ => None,
    }
}

/// Resolves the default root directory where Dimo stores managed `agent-tools/`.
pub fn default_managed_artifacts_dir() -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("DIMO_MANAGED_ARTIFACTS_DIR") {
        let path = PathBuf::from(explicit);
        if !path.as_os_str().is_empty() {
            return Some(path);
        }
    }
    Some(workspace_utils::assets::asset_dir())
}

/// Canonical managed Node runtime layout matching `agent_install.rs`:
/// `<base_dir>/agent-tools/node/{MANAGED_NODE_VERSION}/{platform}/node-v{MANAGED_NODE_VERSION}-{target}`
pub fn managed_node_runtime_for_platform(
    managed_artifacts_dir: &Path,
    platform: &str,
) -> Option<ManagedNodeRuntime> {
    let artifact = managed_node_artifact(platform)?;
    let is_windows = platform.starts_with("windows-");
    let archive_root = managed_artifacts_dir
        .join("agent-tools")
        .join("node")
        .join(MANAGED_NODE_VERSION)
        .join(platform)
        .join(format!("node-v{MANAGED_NODE_VERSION}-{}", artifact.target));
    let bin_dir = if is_windows {
        archive_root
    } else {
        archive_root.join("bin")
    };
    Some(ManagedNodeRuntime {
        node: bin_dir.join(if is_windows { "node.exe" } else { "node" }),
        npm: bin_dir.join(if is_windows { "npm.cmd" } else { "npm" }),
        bin_dir,
    })
}

pub fn managed_node_runtime(managed_artifacts_dir: &Path) -> Option<ManagedNodeRuntime> {
    let platform = current_host_platform()?;
    managed_node_runtime_for_platform(managed_artifacts_dir, platform)
}

pub fn managed_node_verified_marker_path(managed_artifacts_dir: &Path, platform: &str) -> PathBuf {
    managed_artifacts_dir
        .join("agent-tools")
        .join("node")
        .join(MANAGED_NODE_VERSION)
        .join(platform)
        .join(VERIFIED_MARKER_FILENAME)
}

/// O(1) cold-start check: returns `Some(ManagedNodeRuntime)` if `.verified`
/// matches `artifact.sha256` and the `node` executable exists on disk, or if a
/// prior ACP install already extracted both `node` and `npm` (in which case
/// `.verified` is stamped once for subsequent launches).
pub fn probe_verified_managed_node(
    managed_artifacts_dir: &Path,
    platform: &str,
) -> Option<ManagedNodeRuntime> {
    let artifact = managed_node_artifact(platform)?;
    let runtime = managed_node_runtime_for_platform(managed_artifacts_dir, platform)?;
    if !runtime.node.is_file() {
        return None;
    }

    let marker_path = managed_node_verified_marker_path(managed_artifacts_dir, platform);
    if let Ok(raw_marker) = std::fs::read_to_string(&marker_path) {
        if raw_marker.trim().eq_ignore_ascii_case(artifact.sha256) {
            return Some(runtime);
        }
        // An explicit `.verified` marker with a mismatched digest indicates a stale
        // or tampered directory; force re-extraction.
        return None;
    }

    // Adopt a pre-existing `agent_install.rs` extraction that has both `node` and `npm`
    // without re-downloading or re-unpacking.
    if runtime.npm.is_file() {
        let _ = std::fs::write(&marker_path, format!("{}\n", artifact.sha256));
        return Some(runtime);
    }

    None
}

fn sha256_hex_lower(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut hex = String::with_capacity(64);
    for byte in &digest[..] {
        let _ = write!(&mut hex, "{byte:02x}");
    }
    hex
}

pub fn verify_archive_sha256(
    bytes: &[u8],
    expected_sha256: &str,
) -> Result<(), ManagedToolchainError> {
    let actual = sha256_hex_lower(bytes);
    if !actual.eq_ignore_ascii_case(expected_sha256.trim()) {
        return Err(ManagedToolchainError::ChecksumMismatch {
            expected: expected_sha256.to_string(),
            actual,
        });
    }
    Ok(())
}

fn extract_node_archive_sync(
    bytes: &[u8],
    extension: &str,
    staging_dir: &Path,
) -> Result<(), ManagedToolchainError> {
    if extension == "tar.gz" || extension.ends_with(".tar.gz") || extension == "tgz" {
        let decoder = GzDecoder::new(Cursor::new(bytes));
        let mut archive = tar::Archive::new(decoder);
        archive
            .unpack(staging_dir)
            .map_err(|err| ManagedToolchainError::ExtractionFailed(err.to_string()))?;
        return Ok(());
    }

    if extension == "zip" || extension.ends_with(".zip") {
        let archive_path = staging_dir.join(format!(".node-archive-{}.zip", Uuid::new_v4()));
        std::fs::write(&archive_path, bytes)?;
        let unpack_result = extract_zip_archive_sync(&archive_path, staging_dir);
        let _ = std::fs::remove_file(&archive_path);
        return unpack_result;
    }

    Err(ManagedToolchainError::ExtractionFailed(format!(
        "unsupported archive extension `{extension}`"
    )))
}

fn extract_zip_archive_sync(
    archive_path: &Path,
    staging_dir: &Path,
) -> Result<(), ManagedToolchainError> {
    // Prefer system `tar` (`bsdtar` ships with Windows 10/11 and macOS/Linux) for
    // fast native extraction without PowerShell cold-start overhead.
    let tar_status = new_hidden_std_command(
        if cfg!(windows) { "tar.exe" } else { "tar" },
        [
            "-xf",
            &archive_path.to_string_lossy(),
            "-C",
            &staging_dir.to_string_lossy(),
        ],
    )
    .output();

    if let Ok(output) = tar_status
        && output.status.success()
    {
        return Ok(());
    }

    #[cfg(windows)]
    {
        let escaped_zip = archive_path.to_string_lossy().replace('\'', "''");
        let escaped_dest = staging_dir.to_string_lossy().replace('\'', "''");
        let script = format!(
            "$ProgressPreference = 'SilentlyContinue'; Expand-Archive -LiteralPath '{escaped_zip}' -DestinationPath '{escaped_dest}' -Force"
        );
        let output = new_hidden_std_command(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command", &script],
        )
        .output()
        .map_err(|err| ManagedToolchainError::ExtractionFailed(err.to_string()))?;

        if output.status.success() {
            return Ok(());
        }
        Err(ManagedToolchainError::ExtractionFailed(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ))
    }

    #[cfg(not(windows))]
    {
        let output = new_hidden_std_command(
            "unzip",
            [
                "-q",
                &archive_path.to_string_lossy(),
                "-d",
                &staging_dir.to_string_lossy(),
            ],
        )
        .output()
        .map_err(|err| ManagedToolchainError::ExtractionFailed(err.to_string()))?;

        if output.status.success() {
            return Ok(());
        }
        Err(ManagedToolchainError::ExtractionFailed(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ))
    }
}

/// Validates `archive_bytes` against `expected_sha256`, extracts into the
/// canonical managed Node directory for `platform`, and writes `.verified`.
pub async fn install_managed_node_from_archive_bytes(
    managed_artifacts_dir: &Path,
    platform: &str,
    artifact: &ManagedNodeArtifact,
    archive_bytes: &[u8],
) -> Result<ManagedNodeRuntime, ManagedToolchainError> {
    if archive_bytes.len() > MAX_MANAGED_NODE_ARCHIVE_BYTES {
        return Err(ManagedToolchainError::ArchiveTooLarge {
            max_bytes: MAX_MANAGED_NODE_ARCHIVE_BYTES,
        });
    }
    verify_archive_sha256(archive_bytes, artifact.sha256)?;

    let base = managed_artifacts_dir
        .join("agent-tools")
        .join("node")
        .join(MANAGED_NODE_VERSION);
    tokio::fs::create_dir_all(&base).await?;

    let staging = base.join(format!(".staging-{}", Uuid::new_v4()));
    tokio::fs::create_dir_all(&staging).await?;

    let owned_bytes = archive_bytes.to_vec();
    let extension = artifact.extension.to_string();
    let staging_for_unpack = staging.clone();
    let unpack_res = tokio::task::spawn_blocking(move || {
        extract_node_archive_sync(&owned_bytes, &extension, &staging_for_unpack)
    })
    .await
    .map_err(|err| ManagedToolchainError::ExtractionFailed(err.to_string()))
    .and_then(|res| res);

    if let Err(err) = unpack_res {
        let _ = tokio::fs::remove_dir_all(&staging).await;
        return Err(err);
    }

    let is_windows = platform.starts_with("windows-");
    let staged_root = staging.join(format!("node-v{MANAGED_NODE_VERSION}-{}", artifact.target));
    let staged_bin = if is_windows {
        staged_root.clone()
    } else {
        staged_root.join("bin")
    };
    let expected_node = staged_bin.join(if is_windows { "node.exe" } else { "node" });
    if !expected_node.is_file() {
        let _ = tokio::fs::remove_dir_all(&staging).await;
        return Err(ManagedToolchainError::MissingExecutable(expected_node));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = tokio::fs::metadata(&expected_node).await {
            let mut perms = meta.permissions();
            perms.set_mode(0o755);
            let _ = tokio::fs::set_permissions(&expected_node, perms).await;
        }
    }

    let marker_in_staging = staging.join(VERIFIED_MARKER_FILENAME);
    tokio::fs::write(&marker_in_staging, format!("{}\n", artifact.sha256)).await?;

    let final_root = base.join(platform);
    if tokio::fs::metadata(&final_root).await.is_ok() {
        let aside = base.join(format!(".invalid-{}", Uuid::new_v4()));
        tokio::fs::rename(&final_root, &aside).await?;
        if let Err(rename_err) = tokio::fs::rename(&staging, &final_root).await {
            let _ = tokio::fs::rename(&aside, &final_root).await;
            let _ = tokio::fs::remove_dir_all(&staging).await;
            return Err(ManagedToolchainError::Io(rename_err));
        }
        let _ = tokio::fs::remove_dir_all(&aside).await;
    } else if let Err(rename_err) = tokio::fs::rename(&staging, &final_root).await {
        let _ = tokio::fs::remove_dir_all(&staging).await;
        return Err(ManagedToolchainError::Io(rename_err));
    }

    let runtime = managed_node_runtime_for_platform(managed_artifacts_dir, platform)
        .ok_or_else(|| ManagedToolchainError::UnsupportedPlatform(platform.to_string()))?;
    if !runtime.node.is_file() {
        return Err(ManagedToolchainError::MissingExecutable(runtime.node));
    }
    Ok(runtime)
}

async fn download_node_archive(urls: &[String]) -> Result<Vec<u8>, ManagedToolchainError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(NODE_DOWNLOAD_TIMEOUT_SECS))
        .build()
        .map_err(|err| ManagedToolchainError::DownloadFailed {
            urls: urls.to_vec(),
            last_error: err.to_string(),
        })?;

    let mut last_error = String::from("no download URLs configured");
    for url in urls {
        match client.get(url).send().await {
            Ok(resp) => {
                if !resp.status().is_success() {
                    last_error = format!("HTTP {} from {url}", resp.status());
                    continue;
                }
                if let Some(len) = resp.content_length()
                    && len as usize > MAX_MANAGED_NODE_ARCHIVE_BYTES
                {
                    return Err(ManagedToolchainError::ArchiveTooLarge {
                        max_bytes: MAX_MANAGED_NODE_ARCHIVE_BYTES,
                    });
                }
                match resp.bytes().await {
                    Ok(bytes) => {
                        if bytes.len() > MAX_MANAGED_NODE_ARCHIVE_BYTES {
                            return Err(ManagedToolchainError::ArchiveTooLarge {
                                max_bytes: MAX_MANAGED_NODE_ARCHIVE_BYTES,
                            });
                        }
                        return Ok(bytes.to_vec());
                    }
                    Err(err) => {
                        last_error = format!("failed reading response body from {url}: {err}");
                    }
                }
            }
            Err(err) => {
                last_error = format!("request to {url} failed: {err}");
            }
        }
    }

    Err(ManagedToolchainError::DownloadFailed {
        urls: urls.to_vec(),
        last_error,
    })
}

fn parse_node_major_version(version_output: &str) -> Option<u32> {
    let trimmed = version_output.trim().trim_start_matches('v');
    let major_str = trimmed.split('.').next()?;
    major_str.parse::<u32>().ok()
}

fn runtime_from_node_binary(node_path: PathBuf) -> ManagedNodeRuntime {
    let bin_dir = node_path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let npm = bin_dir.join(if cfg!(windows) { "npm.cmd" } else { "npm" });
    ManagedNodeRuntime {
        node: node_path,
        npm,
        bin_dir,
    }
}

async fn probe_system_node_fallback() -> Option<ManagedNodeRuntime> {
    let candidate = workspace_utils::shell::resolve_executable_path(if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    })
    .await?;

    let mut cmd = new_hidden_tokio_command(&candidate, ["--version"]);
    cmd.kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(5), cmd.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let major = parse_node_major_version(&stdout)?;
    (major >= MIN_FALLBACK_SYSTEM_NODE_MAJOR).then(|| runtime_from_node_binary(candidate))
}

fn extraction_mutex() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// Ensures the managed Node.js runtime (`MANAGED_NODE_VERSION`) is extracted,
/// verified via `.verified` SHA-256 marker, and ready to execute.
///
/// Cold-start fast path: if `.verified` matches `artifact.sha256` and `node`
/// exists on disk, returns immediately in O(1) without touching archives or
/// triggering Windows Defender re-scans.
pub async fn ensure_managed_node_runtime(
    managed_artifacts_dir: Option<&Path>,
) -> Result<ManagedNodeRuntime, ManagedToolchainError> {
    if let Some(explicit_node) = std::env::var_os("DIMO_NODE_PATH") {
        let node_path = PathBuf::from(explicit_node);
        if node_path.is_file() {
            return Ok(runtime_from_node_binary(node_path));
        }
    }

    let platform = current_host_platform().ok_or_else(|| {
        ManagedToolchainError::UnsupportedPlatform(format!(
            "{}-{}",
            std::env::consts::OS,
            std::env::consts::ARCH
        ))
    })?;
    let artifact = managed_node_artifact(platform)
        .ok_or_else(|| ManagedToolchainError::UnsupportedPlatform(platform.to_string()))?;

    let owned_default_dir;
    let base_dir = match managed_artifacts_dir {
        Some(dir) => dir,
        None => {
            owned_default_dir = default_managed_artifacts_dir()
                .ok_or(ManagedToolchainError::MissingManagedArtifactsDir)?;
            &owned_default_dir
        }
    };

    if let Some(verified) = probe_verified_managed_node(base_dir, platform) {
        return Ok(verified);
    }

    let _guard = extraction_mutex().lock().await;
    if let Some(verified) = probe_verified_managed_node(base_dir, platform) {
        return Ok(verified);
    }

    let urls = managed_node_download_urls(&artifact);
    match download_node_archive(&urls).await {
        Ok(bytes) => {
            install_managed_node_from_archive_bytes(base_dir, platform, &artifact, &bytes).await
        }
        Err(download_err) => {
            if let Some(system_runtime) = probe_system_node_fallback().await {
                tracing::warn!(
                    error = %download_err,
                    node = %system_runtime.node.display(),
                    "Managed Node.js download unavailable; falling back to verified system Node.js"
                );
                return Ok(system_runtime);
            }
            Err(download_err)
        }
    }
}

/// Convenience wrapper returning the verified `node` (`node.exe` on Windows) binary path.
pub async fn ensure_managed_node(
    managed_artifacts_dir: Option<&Path>,
) -> Result<PathBuf, ManagedToolchainError> {
    let runtime = ensure_managed_node_runtime(managed_artifacts_dir).await?;
    Ok(runtime.node)
}

#[cfg(test)]
mod tests {
    use flate2::{Compression, write::GzEncoder};

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
    fn bun_plans_do_not_require_a_system_bun_on_supported_hosts() {
        assert!(bun_verified_for_install(false, "linux-x86_64"));
        assert!(bun_verified_for_install(false, "linux-aarch64"));
        assert!(bun_verified_for_install(false, "darwin-aarch64"));
        assert!(bun_verified_for_install(false, "darwin-x86_64"));
        assert!(bun_verified_for_install(false, "windows-aarch64"));
        assert!(bun_verified_for_install(false, "windows-x86_64"));
        assert!(!bun_verified_for_install(false, "unknown-os"));
        assert!(bun_verified_for_install(true, "unknown-os"));
    }

    #[test]
    fn managed_node_artifact_matches_the_pinned_dist_url() {
        let artifact = managed_node_artifact("linux-x86_64").expect("linux node");
        assert_eq!(artifact.target, "linux-x64");
        assert_eq!(artifact.extension, "tar.gz");
        assert_eq!(artifact.sha256.len(), 64);

        let with_proxy = managed_node_download_urls_for_proxy(&artifact, true);
        assert_eq!(
            with_proxy[0],
            format!(
                "https://nodejs.org/dist/v{MANAGED_NODE_VERSION}/node-v{MANAGED_NODE_VERSION}-linux-x64.tar.gz"
            )
        );
        assert!(with_proxy.iter().any(|url| url.contains("npmmirror.com")));
        assert!(
            with_proxy
                .iter()
                .any(|url| url.contains("mirror.dimo-ai.com"))
        );

        let no_proxy = managed_node_download_urls_for_proxy(&artifact, false);
        assert!(no_proxy[0].contains("npmmirror.com"));
        assert_eq!(
            no_proxy.last().unwrap(),
            &format!(
                "https://nodejs.org/dist/v{MANAGED_NODE_VERSION}/node-v{MANAGED_NODE_VERSION}-linux-x64.tar.gz"
            )
        );
    }

    #[test]
    fn managed_uv_artifact_routes_between_official_and_mirror() {
        let artifact = managed_uv_artifact("windows-x86_64").expect("windows uv");
        let with_proxy = managed_uv_download_urls_for_proxy(&artifact, true);
        assert_eq!(
            with_proxy[0],
            format!(
                "https://github.com/astral-sh/uv/releases/download/{MANAGED_UV_VERSION}/uv-x86_64-pc-windows-msvc.zip"
            )
        );
        let no_proxy = managed_uv_download_urls_for_proxy(&artifact, false);
        assert_eq!(
            no_proxy[0],
            format!(
                "https://mirror.dimo-ai.com/dl/github/astral-sh/uv/releases/download/{MANAGED_UV_VERSION}/uv-x86_64-pc-windows-msvc.zip"
            )
        );
        assert_eq!(no_proxy[1], with_proxy[0]);
    }

    #[test]
    fn managed_bun_artifact_matches_the_pinned_github_release_url() {
        let artifact = managed_bun_artifact("windows-x86_64").expect("windows bun");
        assert_eq!(artifact.target, "windows-x64");
        assert_eq!(artifact.extension, "zip");
        assert_eq!(artifact.sha256.len(), 64);

        let with_proxy = managed_bun_download_urls_for_proxy(&artifact, true);
        assert_eq!(
            with_proxy[0],
            format!(
                "https://github.com/oven-sh/bun/releases/download/bun-v{MANAGED_BUN_VERSION}/bun-windows-x64.zip"
            )
        );
        assert!(with_proxy.iter().any(|url| url.contains("npmmirror.com")));
        assert!(
            with_proxy
                .iter()
                .any(|url| url.contains("mirror.dimo-ai.com"))
        );

        let no_proxy = managed_bun_download_urls_for_proxy(&artifact, false);
        assert!(no_proxy[0].contains("npmmirror.com"));
        assert!(no_proxy[1].contains("mirror.dimo-ai.com"));
        assert_eq!(no_proxy[2], with_proxy[0]);
    }

    #[test]
    fn verified_marker_fast_path_skips_reextraction_and_rejects_tampered_marker() {
        let temp = tempfile::tempdir().expect("tempdir");
        let platform = "windows-x86_64";
        let artifact = managed_node_artifact(platform).expect("windows node artifact");
        let runtime =
            managed_node_runtime_for_platform(temp.path(), platform).expect("windows runtime");

        assert!(probe_verified_managed_node(temp.path(), platform).is_none());

        std::fs::create_dir_all(&runtime.bin_dir).expect("create bin dir");
        std::fs::write(&runtime.node, b"stub-node-binary").expect("write node.exe");
        let marker = managed_node_verified_marker_path(temp.path(), platform);
        std::fs::write(&marker, format!("{}\n", artifact.sha256)).expect("write .verified");

        let resolved = probe_verified_managed_node(temp.path(), platform)
            .expect("verified marker should hit fast path");
        assert_eq!(resolved.node, runtime.node);

        // A mismatched `.verified` hash must invalidate the cached runtime.
        std::fs::write(
            &marker,
            "0000000000000000000000000000000000000000000000000000000000000000",
        )
        .expect("overwrite .verified with bad sha");
        assert!(probe_verified_managed_node(temp.path(), platform).is_none());
    }

    #[tokio::test]
    async fn archive_install_rejects_sha256_mismatch_and_succeeds_with_matching_digest() {
        let temp = tempfile::tempdir().expect("tempdir");
        let platform = "linux-x86_64";

        // Build a synthetic tar.gz archive matching canonical Node layout:
        // `node-v{MANAGED_NODE_VERSION}-linux-x64/bin/node` and `npm`.
        let mut tar_bytes = Vec::new();
        {
            let encoder = GzEncoder::new(&mut tar_bytes, Compression::fast());
            let mut builder = tar::Builder::new(encoder);

            let node_entry_path = format!("node-v{MANAGED_NODE_VERSION}-linux-x64/bin/node");
            let node_payload = b"#!/bin/sh\necho v22.22.3\n";
            let mut header = tar::Header::new_gnu();
            header.set_size(node_payload.len() as u64);
            header.set_mode(0o755);
            header.set_cksum();
            builder
                .append_data(&mut header, &node_entry_path, &node_payload[..])
                .expect("append node");

            let npm_entry_path = format!("node-v{MANAGED_NODE_VERSION}-linux-x64/bin/npm");
            let npm_payload = b"#!/bin/sh\necho 10.9.0\n";
            let mut npm_header = tar::Header::new_gnu();
            npm_header.set_size(npm_payload.len() as u64);
            npm_header.set_mode(0o755);
            npm_header.set_cksum();
            builder
                .append_data(&mut npm_header, &npm_entry_path, &npm_payload[..])
                .expect("append npm");

            let encoder = builder.into_inner().expect("finish tar");
            encoder.finish().expect("finish gz");
        }

        let wrong_artifact = ManagedNodeArtifact {
            target: "linux-x64",
            extension: "tar.gz",
            sha256: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        };
        let err = install_managed_node_from_archive_bytes(
            temp.path(),
            platform,
            &wrong_artifact,
            &tar_bytes,
        )
        .await
        .expect_err("mismatched sha256 must fail");
        assert!(matches!(
            err,
            ManagedToolchainError::ChecksumMismatch { .. }
        ));

        let actual_sha = sha256_hex_lower(&tar_bytes);
        let actual_sha_leaked_for_test: &'static str = Box::leak(actual_sha.into_boxed_str());
        let valid_artifact = ManagedNodeArtifact {
            target: "linux-x64",
            extension: "tar.gz",
            sha256: actual_sha_leaked_for_test,
        };
        let installed = install_managed_node_from_archive_bytes(
            temp.path(),
            platform,
            &valid_artifact,
            &tar_bytes,
        )
        .await
        .expect("matching sha256 should extract cleanly");
        assert!(installed.node.is_file());
        let marker = managed_node_verified_marker_path(temp.path(), platform);
        assert_eq!(
            std::fs::read_to_string(&marker)
                .expect("read .verified")
                .trim(),
            valid_artifact.sha256
        );
    }

    #[test]
    fn parses_node_major_versions_accurately() {
        assert_eq!(parse_node_major_version("v22.22.3\n"), Some(22));
        assert_eq!(parse_node_major_version("20.11.0"), Some(20));
        assert_eq!(parse_node_major_version("v18.19.1"), Some(18));
        assert_eq!(parse_node_major_version("invalid"), None);
    }
}
