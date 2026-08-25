use std::{
    env,
    io::Cursor,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::Duration,
};

use agents::{AgentId, ShellFamily, publish_managed_runtime_cli};
use flate2::read::GzDecoder;
use reqwest::{Client, redirect::Policy};
use sha2::{Digest, Sha256};
use tar::Archive;

use super::release_download::{GithubReleaseAsset, github_latest_release};

const MAX_ARCHIVE_BYTES: usize = 256 * 1024 * 1024;
const USER_AGENT: &str = "VibeX Git installer";

static INSTALL_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ReleaseTarget {
    asset_suffix: &'static str,
    executable_name: &'static str,
}

impl ReleaseTarget {
    fn current() -> Result<Self, String> {
        Self::for_platform(env::consts::OS, env::consts::ARCH)
    }

    fn for_platform(os: &str, architecture: &str) -> Result<Self, String> {
        let executable_name = if os == "windows" { "git.exe" } else { "git" };
        let asset_suffix = match (os, architecture) {
            ("macos", "aarch64") => "macOS-arm64.tar.gz",
            ("macos", "x86_64") => "macOS-x64.tar.gz",
            ("windows", "aarch64") => "windows-arm64.tar.gz",
            ("windows", "x86_64") => "windows-x64.tar.gz",
            ("windows", "x86" | "i686") => "windows-x86.tar.gz",
            ("linux", "aarch64") => "ubuntu-arm64.tar.gz",
            ("linux", "x86_64") => "ubuntu-x64.tar.gz",
            ("linux", "x86" | "i686") => "ubuntu-x86.tar.gz",
            ("linux", "arm") => "ubuntu-arm.tar.gz",
            _ => {
                return Err(format!(
                    "Git installation is not supported on {os}/{architecture}."
                ));
            }
        };
        Ok(Self {
            asset_suffix,
            executable_name,
        })
    }

    fn matches_asset(self, name: &str) -> bool {
        name.ends_with(self.asset_suffix)
    }
}

pub(crate) fn managed_install_root() -> PathBuf {
    utils::assets::asset_dir().join("tools").join("git")
}

pub(crate) fn find_managed_executable() -> Option<PathBuf> {
    find_git_executable(&managed_install_root())
}

pub(crate) async fn install() -> Result<PathBuf, String> {
    let lock = INSTALL_LOCK.get_or_init(|| tokio::sync::Mutex::new(()));
    let _guard = lock.lock().await;
    if let Some(existing) = find_managed_executable()
        && validate_executable(&existing).await.is_ok()
    {
        publish_to_user_environment(&existing)?;
        return Ok(existing);
    }

    let target = ReleaseTarget::current()?;
    let client = Client::builder()
        .redirect(Policy::limited(8))
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(300))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|error| format!("Failed to create the Git download client: {error}"))?;

    let (release, _) = github_latest_release(&client, "desktop", "dugite-native").await?;
    let asset = release
        .assets
        .iter()
        .find(|asset| target.matches_asset(&asset.name))
        .ok_or_else(|| {
            format!(
                "The latest Git release does not include {}.",
                target.asset_suffix
            )
        })?;
    let (archive, _) = super::release_download::download_with_fallback(
        &client,
        &asset.browser_download_url,
        MAX_ARCHIVE_BYTES,
    )
    .await?;
    verify_asset_checksum(&archive, asset)?;

    let install_root = managed_install_root();
    unpack_tar_gz(&archive, &install_root)?;
    let executable_path = find_git_executable(&install_root).ok_or_else(|| {
        format!(
            "The Git archive does not contain {}.",
            target.executable_name
        )
    })?;
    if let Err(error) = validate_executable(&executable_path).await {
        let _ = std::fs::remove_dir_all(&install_root);
        return Err(error);
    }
    if let Err(error) = publish_to_user_environment(&executable_path) {
        let _ = std::fs::remove_dir_all(&install_root);
        return Err(error);
    }
    Ok(executable_path)
}

pub(crate) async fn configure_identity(
    git_path: &Path,
    user_name: &str,
    user_email: &str,
) -> Result<(), String> {
    set_global_config(git_path, "user.name", user_name).await?;
    set_global_config(git_path, "user.email", user_email).await?;
    Ok(())
}

async fn set_global_config(git_path: &Path, key: &str, value: &str) -> Result<(), String> {
    let mut command =
        utils::process::new_hidden_tokio_command(git_path, ["config", "--global", key, value]);
    command.kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(15), command.output())
        .await
        .map_err(|_| format!("Timed out writing Git {key}."))?
        .map_err(|error| format!("Failed to write Git {key}: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "Failed to write Git {key}: {}",
            utils::process::command_output_detail(&output)
                .unwrap_or_else(|| format!("process exited with status {}", output.status))
        ))
    }
}

async fn validate_executable(executable_path: &Path) -> Result<(), String> {
    let mut command = utils::process::new_hidden_tokio_command(executable_path, ["--version"]);
    command.kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(15), command.output())
        .await
        .map_err(|_| "The installed Git validation timed out.".to_string())?
        .map_err(|error| format!("Failed to start the installed Git: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "The installed Git could not run: {}",
            utils::process::command_output_detail(&output)
                .unwrap_or_else(|| format!("process exited with status {}", output.status))
        ))
    }
}

fn verify_asset_checksum(archive: &[u8], asset: &GithubReleaseAsset) -> Result<(), String> {
    let Some(expected) = asset.sha256_digest() else {
        return Ok(());
    };
    let actual = format!("{:x}", Sha256::digest(archive));
    if actual == expected {
        Ok(())
    } else {
        Err(format!(
            "Git checksum verification failed for {}.",
            asset.name
        ))
    }
}

fn unpack_tar_gz(archive: &[u8], dest: &Path) -> Result<(), String> {
    if dest.exists() {
        std::fs::remove_dir_all(dest)
            .map_err(|error| format!("Failed to replace {}: {error}", dest.display()))?;
    }
    std::fs::create_dir_all(dest)
        .map_err(|error| format!("Failed to create {}: {error}", dest.display()))?;
    let decoder = GzDecoder::new(Cursor::new(archive));
    let mut tar = Archive::new(decoder);
    tar.unpack(dest)
        .map_err(|error| format!("Failed to extract Git: {error}"))?;
    Ok(())
}

fn find_git_executable(root: &Path) -> Option<PathBuf> {
    let executable_name = if cfg!(windows) { "git.exe" } else { "git" };
    git_candidates(root, executable_name)
        .into_iter()
        .find(|path| path.is_file())
}

fn git_candidates(root: &Path, executable_name: &str) -> Vec<PathBuf> {
    let mut candidates = vec![
        root.join("bin").join(executable_name),
        root.join("cmd").join(executable_name),
    ];
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                candidates.push(path.join("bin").join(executable_name));
                candidates.push(path.join("cmd").join(executable_name));
            }
        }
    }
    candidates
}

fn extra_runtime_paths(executable_path: &Path) -> Vec<PathBuf> {
    let Some(parent) = executable_path.parent() else {
        return Vec::new();
    };
    let mut paths = vec![parent.to_path_buf()];
    if let Some(root) = parent.parent() {
        let mingw = root.join("mingw64").join("bin");
        if mingw.is_dir() {
            paths.push(mingw);
        }
        let libexec = root.join("libexec").join("git-core");
        if libexec.is_dir() {
            paths.push(libexec);
        }
    }
    paths
}

fn publish_to_user_environment(executable_path: &Path) -> Result<(), String> {
    let home_dir = dirs::home_dir()
        .ok_or_else(|| "The user home directory could not be determined.".to_string())?;
    let managed_root = managed_install_root();
    let owner = AgentId::parse("git")
        .map_err(|error| format!("Invalid Git installation identity: {error}"))?;
    let published = publish_managed_runtime_cli(
        &home_dir,
        &owner,
        &managed_root,
        executable_path,
        &extra_runtime_paths(executable_path),
        native_shell_family(),
    )
    .map_err(|error| format!("Failed to expose Git to the user environment: {error}"))?;
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
    fn maps_dugite_assets_for_desktop_platforms() {
        assert!(
            ReleaseTarget::for_platform("macos", "aarch64")
                .unwrap()
                .matches_asset("dugite-native-v2.53.0-4098283-macOS-arm64.tar.gz")
        );
        assert!(
            ReleaseTarget::for_platform("windows", "x86_64")
                .unwrap()
                .matches_asset("dugite-native-v2.53.0-4098283-windows-x64.tar.gz")
        );
        assert!(
            !ReleaseTarget::for_platform("linux", "arm")
                .unwrap()
                .matches_asset("dugite-native-v2.53.0-4098283-ubuntu-arm64.tar.gz")
        );
        assert!(
            ReleaseTarget::for_platform("linux", "arm")
                .unwrap()
                .matches_asset("dugite-native-v2.53.0-4098283-ubuntu-arm.tar.gz")
        );
    }

    #[test]
    fn rejects_unsupported_targets() {
        assert!(ReleaseTarget::for_platform("android", "aarch64").is_err());
    }
}
