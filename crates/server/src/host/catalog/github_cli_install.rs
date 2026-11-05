//! Install GitHub CLI into the Host user environment on any desktop OS.

use std::{
    env,
    io::{Cursor, Seek, Write},
    path::{Path, PathBuf},
    sync::OnceLock,
    time::Duration,
};

use agents::{AgentId, ShellFamily, publish_managed_runtime_cli};
use application::ApplicationError;
use flate2::read::GzDecoder;
use reqwest::{Client, redirect::Policy};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const LATEST_RELEASE_URL: &str = "https://github.com/cli/cli/releases/latest";
const RELEASE_DOWNLOAD_ROOT: &str = "https://github.com/cli/cli/releases/download";
const MAINLAND_PROXIES: &[&str] = &["https://ghfast.top/", "https://ghproxy.net/"];
const MAX_ARCHIVE_BYTES: usize = 128 * 1024 * 1024;
const MAX_CHECKSUM_BYTES: usize = 2 * 1024 * 1024;

static INSTALL_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

#[derive(Clone, Copy)]
enum ArchiveKind {
    TarGz,
    Zip,
}

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
            ArchiveKind::Zip => "zip",
            ArchiveKind::TarGz => "tar.gz",
        };
        format!(
            "gh_{version}_{}_{}.{}",
            self.platform, self.architecture, extension
        )
    }
}

pub(super) fn managed_executable_path() -> PathBuf {
    utils::assets::asset_dir()
        .join("tools")
        .join("github-cli")
        .join("bin")
        .join(if cfg!(windows) { "gh.exe" } else { "gh" })
}

pub(super) async fn install() -> Result<PathBuf, ApplicationError> {
    let lock = INSTALL_LOCK.get_or_init(|| tokio::sync::Mutex::new(()));
    let _guard = lock.lock().await;
    let target = ReleaseTarget::current().map_err(ApplicationError::internal)?;
    let client = Client::builder()
        .redirect(Policy::limited(8))
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(180))
        .user_agent("VibeX GitHub CLI installer")
        .build()
        .map_err(|error| {
            ApplicationError::internal(format!(
                "Failed to create the GitHub download client: {error}"
            ))
        })?;
    let version = latest_version(&client).await?;
    let asset_name = target.asset_name(&version);
    let release_root = format!("{RELEASE_DOWNLOAD_ROOT}/v{version}");
    let checksums = download(
        &client,
        &format!("{release_root}/gh_{version}_checksums.txt"),
        MAX_CHECKSUM_BYTES,
    )
    .await?;
    let expected = checksum_for_asset(&checksums, &asset_name)?;
    let archive = download_verified_archive(
        &client,
        &format!("{release_root}/{asset_name}"),
        MAX_ARCHIVE_BYTES,
        &expected,
        &asset_name,
    )
    .await?;
    let executable_path = managed_executable_path();
    install_archive(&archive, &target, &executable_path)?;
    if let Err(error) = validate_executable(&executable_path).await {
        let _ = std::fs::remove_file(&executable_path);
        return Err(ApplicationError::internal(error));
    }
    if let Err(error) = publish_to_user_environment(&executable_path) {
        let _ = std::fs::remove_file(&executable_path);
        return Err(ApplicationError::internal(error));
    }
    Ok(executable_path)
}

fn parse_release_version(raw: &str) -> Option<String> {
    let tag = raw.trim().strip_prefix('v').unwrap_or(raw.trim());
    if tag.is_empty()
        || !tag
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-')
    {
        return None;
    }
    Some(tag.to_string())
}

fn parse_version_from_url(url: &str) -> Option<String> {
    if let Some((_, tail)) = url.rsplit_once("/releases/tag/") {
        let segment = tail.split(['/', '?', '#']).next()?;
        return parse_release_version(segment);
    }
    None
}

async fn latest_version(client: &Client) -> Result<String, ApplicationError> {
    if let Ok((release, _)) =
        super::release_download::github_latest_release(client, "cli", "cli").await
        && let Some(version) = parse_release_version(&release.tag_name)
    {
        return Ok(version);
    }

    let mut last_error = None;
    for url in candidate_urls(LATEST_RELEASE_URL) {
        match client.get(&url).send().await {
            Ok(response) => match response.error_for_status() {
                Ok(response) => {
                    if let Some(version) = parse_version_from_url(response.url().as_str()) {
                        return Ok(version);
                    }
                    if let Some(segment) = response
                        .url()
                        .path_segments()
                        .and_then(Iterator::last)
                        .and_then(|seg| seg.strip_prefix('v'))
                        && let Some(version) = parse_release_version(segment)
                    {
                        return Ok(version);
                    }
                    last_error = Some(format!(
                        "GitHub returned an unexpected latest-release URL: {}",
                        response.url()
                    ));
                }
                Err(error) => last_error = Some(error.to_string()),
            },
            Err(error) => last_error = Some(error.to_string()),
        }
    }

    Err(ApplicationError::internal(last_error.unwrap_or_else(
        || format!("Failed to fetch {LATEST_RELEASE_URL}"),
    )))
}

fn candidate_urls(official: &str) -> Vec<String> {
    let mut urls = vec![official.to_string()];
    if official.starts_with("https://github.com/") {
        for proxy in MAINLAND_PROXIES {
            urls.push(format!("{proxy}{official}"));
        }
    }
    urls
}

async fn download_from_url(
    client: &Client,
    url: &str,
    official: &str,
    limit: usize,
) -> Result<Vec<u8>, String> {
    let response = client
        .get(url)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|error| error.to_string())?;
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(format!(
            "Download exceeds the {limit}-byte safety limit: {official}"
        ));
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() > limit {
        return Err(format!(
            "Download exceeds the {limit}-byte safety limit: {official}"
        ));
    }
    Ok(bytes.to_vec())
}

async fn download(
    client: &Client,
    official: &str,
    limit: usize,
) -> Result<Vec<u8>, ApplicationError> {
    let mut last = None;
    for url in candidate_urls(official) {
        match download_from_url(client, &url, official, limit).await {
            Ok(bytes) => return Ok(bytes),
            Err(error) => last = Some(error),
        }
    }
    Err(ApplicationError::internal(
        last.unwrap_or_else(|| format!("Failed to fetch {official}")),
    ))
}

async fn download_verified_archive(
    client: &Client,
    official: &str,
    limit: usize,
    expected_checksum: &str,
    asset_name: &str,
) -> Result<Vec<u8>, ApplicationError> {
    let mut last = None;
    for url in candidate_urls(official) {
        match download_from_url(client, &url, official, limit).await {
            Ok(bytes) => match verify_checksum(&bytes, expected_checksum, asset_name) {
                Ok(()) => return Ok(bytes),
                Err(error) => last = Some(error.envelope().message.clone()),
            },
            Err(error) => last = Some(error),
        }
    }
    Err(ApplicationError::internal(
        last.unwrap_or_else(|| format!("Failed to fetch {official}")),
    ))
}

fn checksum_for_asset(checksums: &[u8], asset_name: &str) -> Result<String, ApplicationError> {
    let text = std::str::from_utf8(checksums).map_err(|error| {
        ApplicationError::internal(format!("GitHub CLI checksums are not valid UTF-8: {error}"))
    })?;
    text.lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let checksum = fields.next()?;
            let file_name = fields.next()?.trim_start_matches('*');
            (file_name == asset_name && checksum.len() == 64).then(|| checksum.to_ascii_lowercase())
        })
        .next()
        .ok_or_else(|| {
            ApplicationError::internal(format!(
                "GitHub CLI checksum for {asset_name} was not found."
            ))
        })
}

fn verify_checksum(
    archive: &[u8],
    expected: &str,
    asset_name: &str,
) -> Result<(), ApplicationError> {
    let actual = format!("{:x}", Sha256::digest(archive));
    if actual == expected {
        Ok(())
    } else {
        Err(ApplicationError::internal(format!(
            "GitHub CLI checksum verification failed for {asset_name}."
        )))
    }
}

fn install_archive(
    archive: &[u8],
    target: &ReleaseTarget,
    executable_path: &Path,
) -> Result<(), ApplicationError> {
    let bin_dir = executable_path.parent().ok_or_else(|| {
        ApplicationError::internal("Managed GitHub CLI path has no parent directory.")
    })?;
    std::fs::create_dir_all(bin_dir).map_err(|error| {
        ApplicationError::internal(format!("Failed to create {}: {error}", bin_dir.display()))
    })?;
    let staged_path = bin_dir.join(format!(".gh-staging-{}", Uuid::new_v4().simple()));
    let mut staged = std::fs::File::create(&staged_path).map_err(|error| {
        ApplicationError::internal(format!("Failed to stage GitHub CLI: {error}"))
    })?;
    if let Err(error) = extract_executable(archive, target, &mut staged) {
        drop(staged);
        let _ = std::fs::remove_file(&staged_path);
        return Err(error);
    }
    if let Err(error) = staged.flush() {
        drop(staged);
        let _ = std::fs::remove_file(&staged_path);
        return Err(ApplicationError::internal(format!(
            "Failed to flush GitHub CLI: {error}"
        )));
    }
    drop(staged);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&staged_path, std::fs::Permissions::from_mode(0o755)).map_err(
            |error| {
                let _ = std::fs::remove_file(&staged_path);
                ApplicationError::internal(format!("Failed to make GitHub CLI executable: {error}"))
            },
        )?;
    }
    if executable_path.exists() {
        std::fs::remove_file(executable_path).map_err(|error| {
            let _ = std::fs::remove_file(&staged_path);
            ApplicationError::internal(format!(
                "Failed to replace {}: {error}",
                executable_path.display()
            ))
        })?;
    }
    std::fs::rename(&staged_path, executable_path).map_err(|error| {
        let _ = std::fs::remove_file(&staged_path);
        ApplicationError::internal(format!(
            "Failed to install GitHub CLI at {}: {error}",
            executable_path.display()
        ))
    })?;
    Ok(())
}

fn extract_executable<W: Write + Seek>(
    archive: &[u8],
    target: &ReleaseTarget,
    destination: &mut W,
) -> Result<(), ApplicationError> {
    match target.archive_kind {
        ArchiveKind::Zip => extract_zip(archive, target.executable_name, destination),
        ArchiveKind::TarGz => extract_tar_gz(archive, target.executable_name, destination),
    }
}

fn archive_entry_matches_bin(entry_path: &Path, executable_name: &str) -> bool {
    let expected_suffix = Path::new("bin").join(executable_name);
    entry_path.ends_with(&expected_suffix)
}

fn extract_zip<W: Write + Seek>(
    archive: &[u8],
    executable_name: &str,
    destination: &mut W,
) -> Result<(), ApplicationError> {
    let mut archive = zip::ZipArchive::new(Cursor::new(archive))
        .map_err(|error| ApplicationError::internal(format!("Invalid GitHub CLI zip: {error}")))?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| {
            ApplicationError::internal(format!("Failed to read GitHub CLI zip: {error}"))
        })?;
        let normalized_name = entry.name().replace('\\', "/");
        if entry.is_file()
            && archive_entry_matches_bin(Path::new(&normalized_name), executable_name)
        {
            std::io::copy(&mut entry, destination).map_err(|error| {
                ApplicationError::internal(format!("Failed to extract GitHub CLI: {error}"))
            })?;
            return Ok(());
        }
    }
    Err(ApplicationError::internal(format!(
        "The GitHub CLI archive does not contain bin/{executable_name}."
    )))
}

fn extract_tar_gz<W: Write + Seek>(
    archive: &[u8],
    executable_name: &str,
    destination: &mut W,
) -> Result<(), ApplicationError> {
    let decoder = GzDecoder::new(Cursor::new(archive));
    let mut archive = tar::Archive::new(decoder);
    let entries = archive.entries().map_err(|error| {
        ApplicationError::internal(format!("Invalid GitHub CLI tar archive: {error}"))
    })?;
    for entry in entries {
        let mut entry = entry.map_err(|error| {
            ApplicationError::internal(format!("Failed to read GitHub CLI tar archive: {error}"))
        })?;
        let path = entry.path().map_err(|error| {
            ApplicationError::internal(format!("Invalid path in GitHub CLI archive: {error}"))
        })?;
        if entry.header().entry_type().is_file()
            && archive_entry_matches_bin(&path, executable_name)
        {
            std::io::copy(&mut entry, destination).map_err(|error| {
                ApplicationError::internal(format!("Failed to extract GitHub CLI: {error}"))
            })?;
            return Ok(());
        }
    }
    Err(ApplicationError::internal(format!(
        "The GitHub CLI archive does not contain bin/{executable_name}."
    )))
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

fn publish_to_user_environment(executable_path: &Path) -> Result<(), String> {
    let home_dir = dirs::home_dir()
        .ok_or_else(|| "The user home directory could not be determined.".to_string())?;
    let _ = agents::remove_orphaned_cli_shims(&home_dir);
    let managed_root = utils::assets::asset_dir().join("tools").join("github-cli");
    let owner = AgentId::parse("github-cli")
        .map_err(|error| format!("Invalid GitHub CLI installation identity: {error}"))?;
    let runtime_paths = executable_path
        .parent()
        .map(|parent| vec![parent.to_path_buf()])
        .unwrap_or_default();
    let shell = native_shell_family();
    let published = publish_managed_runtime_cli(
        &home_dir,
        &owner,
        &managed_root,
        executable_path,
        &runtime_paths,
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
    use std::io::Cursor;

    use super::{ReleaseTarget, extract_zip, parse_version_from_url};

    #[test]
    fn maps_official_release_assets_for_linux_macos_and_windows() {
        assert_eq!(
            ReleaseTarget::for_platform("linux", "x86_64")
                .unwrap()
                .asset_name("2.94.0"),
            "gh_2.94.0_linux_amd64.tar.gz"
        );
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
    }

    #[test]
    fn extracts_gh_from_both_root_level_windows_zip_and_nested_zip() {
        for entry_name in ["bin/gh.exe", "gh_2.94.0_windows_amd64/bin/gh.exe"] {
            let mut buffer = Cursor::new(Vec::new());
            {
                let mut zip = zip::ZipWriter::new(&mut buffer);
                let options = zip::write::SimpleFileOptions::default();
                zip.start_file(entry_name, options).expect("start zip file");
                std::io::Write::write_all(&mut zip, b"gh-windows-binary").expect("write zip");
                zip.finish().expect("finish zip");
            }
            let mut output = Cursor::new(Vec::new());
            extract_zip(buffer.get_ref(), "gh.exe", &mut output)
                .expect("should extract gh.exe from zip");
            assert_eq!(output.into_inner(), b"gh-windows-binary");
        }
    }

    #[test]
    fn parses_version_from_redirected_release_urls() {
        assert_eq!(
            parse_version_from_url("https://github.com/cli/cli/releases/tag/v2.94.0").as_deref(),
            Some("2.94.0")
        );
        assert_eq!(
            parse_version_from_url(
                "https://ghfast.top/https://github.com/cli/cli/releases/tag/v2.94.0"
            )
            .as_deref(),
            Some("2.94.0")
        );
        assert_eq!(
            parse_version_from_url("https://ghfast.top/https://github.com/cli/cli/releases/latest"),
            None
        );
    }
}
