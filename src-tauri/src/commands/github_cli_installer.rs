use std::{
    env,
    io::{Cursor, Seek, Write},
    path::{Path, PathBuf},
    sync::OnceLock,
    time::Duration,
};

use agents::{AgentId, ShellFamily, publish_managed_runtime_cli};
use flate2::read::GzDecoder;
use reqwest::{Client, redirect::Policy};
use sha2::{Digest, Sha256};
use tempfile::NamedTempFile;

const LATEST_RELEASE_URL: &str = "https://github.com/cli/cli/releases/latest";
const RELEASE_DOWNLOAD_ROOT: &str = "https://github.com/cli/cli/releases/download";
const MAX_ARCHIVE_BYTES: usize = 128 * 1024 * 1024;
const MAX_CHECKSUM_BYTES: usize = 2 * 1024 * 1024;

static INSTALL_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArchiveKind {
    TarGz,
    Zip,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ReleaseTarget {
    platform: &'static str,
    architecture: &'static str,
    archive_kind: ArchiveKind,
    executable_name: &'static str,
}

impl ReleaseTarget {
    fn current() -> Result<Self, String> {
        Self::for_platform(env::consts::OS, env::consts::ARCH)
    }

    fn for_platform(os: &str, architecture: &str) -> Result<Self, String> {
        let architecture = match architecture {
            "x86_64" => "amd64",
            "aarch64" => "arm64",
            "x86" | "i686" => "386",
            "arm" if os == "linux" => "armv6",
            _ => {
                return Err(format!(
                    "GitHub CLI does not provide a supported release for {os}/{architecture}."
                ));
            }
        };

        match os {
            "macos" if matches!(architecture, "amd64" | "arm64") => Ok(Self {
                platform: "macOS",
                architecture,
                archive_kind: ArchiveKind::Zip,
                executable_name: "gh",
            }),
            "windows" if matches!(architecture, "amd64" | "arm64" | "386") => Ok(Self {
                platform: "windows",
                architecture,
                archive_kind: ArchiveKind::Zip,
                executable_name: "gh.exe",
            }),
            "linux" if matches!(architecture, "amd64" | "arm64" | "386" | "armv6") => Ok(Self {
                platform: "linux",
                architecture,
                archive_kind: ArchiveKind::TarGz,
                executable_name: "gh",
            }),
            _ => Err(format!(
                "GitHub CLI installation is not supported on {os}/{architecture}."
            )),
        }
    }

    fn asset_name(&self, version: &str) -> String {
        let extension = match self.archive_kind {
            ArchiveKind::TarGz => "tar.gz",
            ArchiveKind::Zip => "zip",
        };
        format!(
            "gh_{version}_{}_{}.{}",
            self.platform, self.architecture, extension
        )
    }
}

pub(crate) fn managed_executable_path() -> PathBuf {
    utils::assets::asset_dir()
        .join("tools")
        .join("github-cli")
        .join("bin")
        .join(if cfg!(windows) { "gh.exe" } else { "gh" })
}

pub(crate) async fn install() -> Result<PathBuf, String> {
    let lock = INSTALL_LOCK.get_or_init(|| tokio::sync::Mutex::new(()));
    let _guard = lock.lock().await;
    let target = ReleaseTarget::current()?;
    let client = Client::builder()
        .redirect(Policy::limited(8))
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(180))
        .user_agent("VibeX GitHub CLI installer")
        .build()
        .map_err(|error| format!("Failed to create the GitHub download client: {error}"))?;

    let version = latest_version(&client).await?;
    let asset_name = target.asset_name(&version);
    let release_root = format!("{RELEASE_DOWNLOAD_ROOT}/v{version}");
    let checksum_name = format!("gh_{version}_checksums.txt");
    let (checksums, _) = super::release_download::download_with_fallback(
        &client,
        &format!("{release_root}/{checksum_name}"),
        MAX_CHECKSUM_BYTES,
    )
    .await?;
    let expected_checksum = checksum_for_asset(&checksums, &asset_name)?;
    let (archive, _) = super::release_download::download_with_fallback(
        &client,
        &format!("{release_root}/{asset_name}"),
        MAX_ARCHIVE_BYTES,
    )
    .await?;
    verify_checksum(&archive, &expected_checksum, &asset_name)?;

    let executable_path = managed_executable_path();
    install_archive(&archive, &target, &executable_path)?;
    if let Err(error) = validate_executable(&executable_path).await {
        let _ = std::fs::remove_file(&executable_path);
        return Err(error);
    }
    if let Err(error) = publish_to_user_environment(&executable_path) {
        let _ = std::fs::remove_file(&executable_path);
        return Err(error);
    }
    Ok(executable_path)
}

async fn validate_executable(executable_path: &Path) -> Result<(), String> {
    let mut command = utils::process::new_hidden_tokio_command(executable_path, ["--version"]);
    command.kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(15), command.output())
        .await
        .map_err(|_| "The installed GitHub CLI validation timed out.".to_string())?
        .map_err(|error| format!("Failed to start the installed GitHub CLI: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "The installed GitHub CLI could not run: {}",
            utils::process::command_output_detail(&output)
                .unwrap_or_else(|| format!("process exited with status {}", output.status))
        ))
    }
}

async fn latest_version(client: &Client) -> Result<String, String> {
    let (response, _) =
        super::release_download::get_with_fallback(client, LATEST_RELEASE_URL).await?;
    let tag = response
        .url()
        .path_segments()
        .and_then(Iterator::last)
        .and_then(|segment| segment.strip_prefix('v'))
        .ok_or_else(|| {
            format!(
                "GitHub returned an unexpected latest-release URL: {}",
                response.url()
            )
        })?;
    semver::Version::parse(tag)
        .map_err(|error| format!("GitHub returned an invalid release version `{tag}`: {error}"))?;
    Ok(tag.to_string())
}

fn checksum_for_asset(checksums: &[u8], asset_name: &str) -> Result<String, String> {
    let text = std::str::from_utf8(checksums)
        .map_err(|error| format!("GitHub CLI checksums are not valid UTF-8: {error}"))?;
    text.lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let checksum = fields.next()?;
            let file_name = fields.next()?;
            (file_name == asset_name && checksum.len() == 64).then(|| checksum.to_ascii_lowercase())
        })
        .next()
        .ok_or_else(|| format!("GitHub CLI checksum for {asset_name} was not found."))
}

fn verify_checksum(archive: &[u8], expected: &str, asset_name: &str) -> Result<(), String> {
    let actual = format!("{:x}", Sha256::digest(archive));
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "GitHub CLI checksum verification failed for {asset_name}."
        ))
    }
}

fn install_archive(
    archive: &[u8],
    target: &ReleaseTarget,
    executable_path: &Path,
) -> Result<(), String> {
    let bin_dir = executable_path
        .parent()
        .ok_or_else(|| "Managed GitHub CLI path has no parent directory.".to_string())?;
    std::fs::create_dir_all(bin_dir)
        .map_err(|error| format!("Failed to create {}: {error}", bin_dir.display()))?;
    let mut staged = NamedTempFile::new_in(bin_dir)
        .map_err(|error| format!("Failed to stage GitHub CLI: {error}"))?;
    extract_executable(archive, target, staged.as_file_mut())?;
    staged
        .as_file_mut()
        .flush()
        .map_err(|error| format!("Failed to flush the GitHub CLI executable: {error}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        staged
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o755))
            .map_err(|error| format!("Failed to make GitHub CLI executable: {error}"))?;
    }

    if executable_path.exists() {
        std::fs::remove_file(executable_path)
            .map_err(|error| format!("Failed to replace {}: {error}", executable_path.display()))?;
    }
    staged.persist(executable_path).map_err(|error| {
        format!(
            "Failed to install GitHub CLI at {}: {}",
            executable_path.display(),
            error.error
        )
    })?;
    Ok(())
}

fn extract_executable<W: Write + Seek>(
    archive: &[u8],
    target: &ReleaseTarget,
    destination: &mut W,
) -> Result<(), String> {
    match target.archive_kind {
        ArchiveKind::Zip => extract_zip_executable(archive, target.executable_name, destination),
        ArchiveKind::TarGz => {
            extract_tar_gz_executable(archive, target.executable_name, destination)
        }
    }
}

fn extract_zip_executable<W: Write + Seek>(
    archive: &[u8],
    executable_name: &str,
    destination: &mut W,
) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(archive))
        .map_err(|error| format!("Invalid GitHub CLI zip archive: {error}"))?;
    let expected_suffix = format!("/bin/{executable_name}");
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("Failed to read GitHub CLI zip archive: {error}"))?;
        if entry.is_file() && entry.name().ends_with(&expected_suffix) {
            std::io::copy(&mut entry, destination)
                .map_err(|error| format!("Failed to extract GitHub CLI: {error}"))?;
            return Ok(());
        }
    }
    Err(format!(
        "The GitHub CLI archive does not contain bin/{executable_name}."
    ))
}

fn extract_tar_gz_executable<W: Write + Seek>(
    archive: &[u8],
    executable_name: &str,
    destination: &mut W,
) -> Result<(), String> {
    let decoder = GzDecoder::new(Cursor::new(archive));
    let mut archive = tar::Archive::new(decoder);
    let expected_suffix = Path::new("bin").join(executable_name);
    let entries = archive
        .entries()
        .map_err(|error| format!("Invalid GitHub CLI tar archive: {error}"))?;
    for entry in entries {
        let mut entry =
            entry.map_err(|error| format!("Failed to read GitHub CLI tar archive: {error}"))?;
        let path = entry
            .path()
            .map_err(|error| format!("Invalid path in GitHub CLI archive: {error}"))?;
        if entry.header().entry_type().is_file() && path.ends_with(&expected_suffix) {
            std::io::copy(&mut entry, destination)
                .map_err(|error| format!("Failed to extract GitHub CLI: {error}"))?;
            return Ok(());
        }
    }
    Err(format!(
        "The GitHub CLI archive does not contain bin/{executable_name}."
    ))
}

fn publish_to_user_environment(executable_path: &Path) -> Result<(), String> {
    let home_dir = dirs::home_dir()
        .ok_or_else(|| "The user home directory could not be determined.".to_string())?;
    let managed_root = utils::assets::asset_dir().join("tools").join("github-cli");
    let owner = AgentId::parse("github-cli")
        .map_err(|error| format!("Invalid GitHub CLI installation identity: {error}"))?;
    let shell = native_shell_family();
    let published = publish_managed_runtime_cli(
        &home_dir,
        &owner,
        &managed_root,
        executable_path,
        &[],
        shell,
    )
    .map_err(|error| format!("Failed to expose GitHub CLI to the user environment: {error}"))?;
    if let Some(bin_dir) = published.shim_path.parent() {
        utils::shell::expose_user_bin_to_process_path(bin_dir);
    }
    Ok(())
}

#[cfg(windows)]
fn native_shell_family() -> ShellFamily {
    ShellFamily::Windows
}

#[cfg(not(windows))]
fn native_shell_family() -> ShellFamily {
    let shell = env::var_os("SHELL").map(PathBuf::from);
    ShellFamily::from_shell_path(shell.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_official_release_assets_for_all_desktop_platforms() {
        assert_eq!(
            ReleaseTarget::for_platform("macos", "aarch64")
                .unwrap()
                .asset_name("2.94.0"),
            "gh_2.94.0_macOS_arm64.zip"
        );
        assert_eq!(
            ReleaseTarget::for_platform("windows", "x86_64")
                .unwrap()
                .asset_name("2.94.0"),
            "gh_2.94.0_windows_amd64.zip"
        );
        assert_eq!(
            ReleaseTarget::for_platform("linux", "aarch64")
                .unwrap()
                .asset_name("2.94.0"),
            "gh_2.94.0_linux_arm64.tar.gz"
        );
    }

    #[test]
    fn selects_only_the_requested_release_checksum() {
        let checksums =
            b"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  other.zip\n\
bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  gh_2.94.0_macOS_arm64.zip\n";
        assert_eq!(
            checksum_for_asset(checksums, "gh_2.94.0_macOS_arm64.zip").unwrap(),
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        );
    }
}
