use std::{
    collections::BTreeMap,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    time::Duration,
};

use async_trait::async_trait;
use sha2::{Digest, Sha256};
use tokio::process::Command;
use tool_runtime::{Downloader, HttpDownloader};

use crate::{PluginError, RuntimeContribution, RuntimeInstall, RuntimeInstallation};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeProcess {
    pub program: String,
    pub args: Vec<String>,
    pub environment: BTreeMap<String, String>,
    pub shell: bool,
}

#[async_trait]
pub trait GlobalRuntimeHost: Send + Sync {
    async fn run(&self, process: RuntimeProcess) -> Result<(), String>;
    async fn install_binary(
        &self,
        runtime_id: &str,
        command: &str,
        url: &str,
        sha256: Option<&str>,
    ) -> Result<(), String> {
        let _ = (command, url, sha256);
        Err(format!(
            "binary installer is unavailable for `{runtime_id}`"
        ))
    }
    async fn install_archive(
        &self,
        runtime_id: &str,
        command: &str,
        url: &str,
        sha256: Option<&str>,
    ) -> Result<(), String> {
        let _ = (command, url, sha256);
        Err(format!(
            "archive installer is unavailable for `{runtime_id}`"
        ))
    }
    async fn resolve(&self, command: &str) -> Result<PathBuf, String>;
    async fn probe(&self, executable: &Path, args: &[String]) -> Result<String, String>;
}

pub struct GlobalRuntimeInstaller<'a, H: GlobalRuntimeHost + ?Sized> {
    host: &'a H,
}

impl<'a, H: GlobalRuntimeHost + ?Sized> GlobalRuntimeInstaller<'a, H> {
    pub fn new(host: &'a H) -> Self {
        Self { host }
    }

    pub async fn install(
        &self,
        plugin_id: &str,
        shell_trusted: bool,
        runtime: &RuntimeContribution,
    ) -> Result<RuntimeInstallation, PluginError> {
        if runtime.probe.is_empty() {
            return Err(PluginError::runtime_not_ready(
                &runtime.id,
                "the plugin did not declare a probe",
            ));
        }

        match &runtime.install {
            RuntimeInstall::Binary { url, sha256 } => self
                .host
                .install_binary(&runtime.id, &runtime.command, url, sha256.as_deref())
                .await
                .map_err(|error| PluginError::runtime_install_failed(&runtime.id, error))?,
            RuntimeInstall::Archive { url, sha256 } => self
                .host
                .install_archive(&runtime.id, &runtime.command, url, sha256.as_deref())
                .await
                .map_err(|error| PluginError::runtime_install_failed(&runtime.id, error))?,
            _ => {
                if let Some(process) = install_process(plugin_id, shell_trusted, runtime)? {
                    self.host
                        .run(process)
                        .await
                        .map_err(|error| PluginError::runtime_install_failed(&runtime.id, error))?;
                }
            }
        }

        let executable = self
            .host
            .resolve(&runtime.command)
            .await
            .map_err(|error| PluginError::runtime_not_ready(&runtime.id, error))?;
        let probe_output = self
            .host
            .probe(&executable, &runtime.probe)
            .await
            .map_err(|error| PluginError::runtime_not_ready(&runtime.id, error))?;
        let version = match runtime.version.as_deref() {
            Some(expected) if !probe_output.contains(expected) => {
                return Err(PluginError::runtime_not_ready(
                    &runtime.id,
                    format!(
                        "probe output `{}` does not contain required version `{expected}`",
                        probe_output.trim()
                    ),
                ));
            }
            Some(expected) => expected.to_owned(),
            None => probe_output.trim().to_owned(),
        };
        Ok(RuntimeInstallation {
            id: runtime.id.clone(),
            version,
            executable_path: executable,
            installer: runtime_install_key(&runtime.install).to_owned(),
            probe: runtime.probe.clone(),
        })
    }
}

fn runtime_install_key(install: &RuntimeInstall) -> &'static str {
    match install {
        RuntimeInstall::Existing => "existing",
        RuntimeInstall::Binary { .. } => "binary",
        RuntimeInstall::Archive { .. } => "archive",
        RuntimeInstall::Npm { .. } => "npm",
        RuntimeInstall::Pipx { .. } => "pipx",
        RuntimeInstall::Cargo { .. } => "cargo",
        RuntimeInstall::Shell { .. } => "shell",
    }
}

fn install_process(
    plugin_id: &str,
    shell_trusted: bool,
    runtime: &RuntimeContribution,
) -> Result<Option<RuntimeProcess>, PluginError> {
    let environment = sanitized_runtime_environment();
    let process = match &runtime.install {
        RuntimeInstall::Existing => return Ok(None),
        RuntimeInstall::Npm { package } => RuntimeProcess {
            program: "npm".to_owned(),
            args: vec!["install".to_owned(), "--global".to_owned(), package.clone()],
            environment,
            shell: false,
        },
        RuntimeInstall::Pipx { package } => RuntimeProcess {
            program: "pipx".to_owned(),
            args: vec!["install".to_owned(), "--force".to_owned(), package.clone()],
            environment,
            shell: false,
        },
        RuntimeInstall::Cargo { crate_name } => RuntimeProcess {
            program: "cargo".to_owned(),
            args: vec![
                "install".to_owned(),
                crate_name.clone(),
                "--force".to_owned(),
            ],
            environment,
            shell: false,
        },
        RuntimeInstall::Shell { command } => {
            if !shell_trusted {
                return Err(PluginError::shell_trust_required(plugin_id));
            }
            let (program, argument) = utils::shell::get_shell_command();
            RuntimeProcess {
                program,
                args: vec![argument.to_owned(), command.clone()],
                environment,
                shell: true,
            }
        }
        RuntimeInstall::Binary { .. } | RuntimeInstall::Archive { .. } => return Ok(None),
    };
    Ok(Some(process))
}

pub fn sanitized_runtime_environment() -> BTreeMap<String, String> {
    std::env::vars()
        .filter(|(key, _)| is_safe_environment_key(key))
        .collect()
}

fn is_safe_environment_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    if [
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "CREDENTIAL",
        "API_KEY",
        "OPENAI",
        "ANTHROPIC",
        "VIBEX",
    ]
    .iter()
    .any(|needle| upper.contains(needle))
    {
        return false;
    }
    matches!(
        upper.as_str(),
        "HOME"
            | "USER"
            | "USERNAME"
            | "LOGNAME"
            | "PATH"
            | "PATHEXT"
            | "SHELL"
            | "COMSPEC"
            | "SYSTEMROOT"
            | "WINDIR"
            | "TMP"
            | "TEMP"
            | "TMPDIR"
            | "LANG"
            | "TERM"
            | "COLORTERM"
            | "PNPM_HOME"
            | "NPM_CONFIG_PREFIX"
            | "CARGO_HOME"
            | "RUSTUP_HOME"
            | "PIPX_HOME"
            | "PIPX_BIN_DIR"
    ) || upper.starts_with("LC_")
        || upper.starts_with("XDG_")
}

#[derive(Default)]
pub struct SystemGlobalRuntimeHost;

#[async_trait]
impl GlobalRuntimeHost for SystemGlobalRuntimeHost {
    async fn run(&self, process: RuntimeProcess) -> Result<(), String> {
        let mut command = Command::new(&process.program);
        command
            .args(&process.args)
            .env_clear()
            .envs(&process.environment);
        let output = command.output().await.map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err(process_failure(&output));
        }
        let _ = utils::shell::refresh_process_path_after_install().await;
        Ok(())
    }

    async fn install_binary(
        &self,
        runtime_id: &str,
        command: &str,
        url: &str,
        sha256: Option<&str>,
    ) -> Result<(), String> {
        validate_global_command(command)?;
        let bytes = download_and_verify(url, sha256).await?;
        publish_global_executable(runtime_id, command, &bytes).await
    }

    async fn install_archive(
        &self,
        runtime_id: &str,
        command: &str,
        url: &str,
        sha256: Option<&str>,
    ) -> Result<(), String> {
        validate_global_command(command)?;
        let bytes = download_and_verify(url, sha256).await?;
        let url = url.to_owned();
        let command = command.to_owned();
        let archive_command = command.clone();
        let executable = tokio::task::spawn_blocking(move || {
            executable_from_archive(&bytes, &url, &archive_command)
        })
        .await
        .map_err(|error| format!("archive extraction task failed: {error}"))??;
        publish_global_executable(runtime_id, &command, &executable).await
    }

    async fn resolve(&self, command: &str) -> Result<PathBuf, String> {
        let _ = utils::shell::refresh_process_path_after_install().await;
        let executable = utils::shell::resolve_executable_path(command)
            .await
            .ok_or_else(|| format!("command `{command}` was not found"))?;
        if let Some(parent) = executable.parent() {
            utils::shell::expose_user_bin_to_process_path(parent);
        }
        Ok(executable)
    }

    async fn probe(&self, executable: &Path, args: &[String]) -> Result<String, String> {
        let output = Command::new(executable)
            .args(args)
            .env_clear()
            .envs(sanitized_runtime_environment())
            .output()
            .await
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err(process_failure(&output));
        }
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        if stdout.is_empty() {
            Ok(stderr)
        } else {
            Ok(stdout)
        }
    }
}

const MAX_ARCHIVE_EXECUTABLE_BYTES: u64 = 256 * 1024 * 1024;

async fn download_and_verify(url: &str, expected_sha256: Option<&str>) -> Result<Vec<u8>, String> {
    let downloader = HttpDownloader::new(Duration::from_secs(15), Duration::from_secs(120));
    let bytes = downloader
        .fetch(url)
        .await
        .map_err(|error| error.to_string())?;
    if let Some(expected) = expected_sha256 {
        let actual = format!("{:x}", Sha256::digest(&bytes));
        if !actual.eq_ignore_ascii_case(expected) {
            return Err(format!(
                "download checksum mismatch: expected `{expected}`, got `{actual}`"
            ));
        }
    }
    Ok(bytes)
}

fn validate_global_command(command: &str) -> Result<(), String> {
    let path = Path::new(command);
    if command.trim().is_empty()
        || path.is_absolute()
        || path.components().count() != 1
        || path.file_name().and_then(|name| name.to_str()) != Some(command)
    {
        return Err("binary/archive Runtime command must be one executable filename".to_owned());
    }
    Ok(())
}

async fn publish_global_executable(
    runtime_id: &str,
    command: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let home = dirs::home_dir().ok_or_else(|| "user home directory is unavailable".to_owned())?;
    let directory = home.join(".local/bin");
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|error| error.to_string())?;
    let target = directory.join(command);
    let runtime_key = format!("{:x}", Sha256::digest(runtime_id.as_bytes()));
    let staging = directory.join(format!(".{command}.{}.vibex-incoming", &runtime_key[..12]));
    tokio::fs::write(&staging, bytes)
        .await
        .map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o755))
            .await
            .map_err(|error| error.to_string())?;
    }
    if tokio::fs::symlink_metadata(&target).await.is_ok() {
        tokio::fs::remove_file(&target)
            .await
            .map_err(|error| error.to_string())?;
    }
    tokio::fs::rename(&staging, &target)
        .await
        .map_err(|error| error.to_string())?;
    utils::shell::expose_user_bin_to_process_path(&directory);
    Ok(())
}

fn executable_from_archive(bytes: &[u8], url: &str, command: &str) -> Result<Vec<u8>, String> {
    let lower_url = url::Url::parse(url)
        .map_err(|_| "archive URL is invalid".to_owned())?
        .path()
        .to_ascii_lowercase();
    if lower_url.ends_with(".zip") {
        return executable_from_zip(bytes, command);
    }
    if lower_url.ends_with(".tar.gz") || lower_url.ends_with(".tgz") {
        return executable_from_tar(flate2::read::GzDecoder::new(Cursor::new(bytes)), command);
    }
    if lower_url.ends_with(".tar") {
        return executable_from_tar(Cursor::new(bytes), command);
    }
    Err("archive URL must end in .zip, .tar, .tar.gz, or .tgz".to_owned())
}

fn executable_from_zip(bytes: &[u8], command: &str) -> Result<Vec<u8>, String> {
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|error| error.to_string())?;
    let mut best: Option<(usize, Vec<u8>)> = None;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let Some(path) = entry.enclosed_name() else {
            continue;
        };
        let is_symlink = entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000);
        if entry.is_dir()
            || is_symlink
            || path.file_name().and_then(|name| name.to_str()) != Some(command)
        {
            continue;
        }
        let depth = path.components().count();
        let contents = read_bounded(&mut entry)?;
        if best
            .as_ref()
            .is_none_or(|(best_depth, _)| depth < *best_depth)
        {
            best = Some((depth, contents));
        }
    }
    best.map(|(_, bytes)| bytes)
        .ok_or_else(|| format!("archive does not contain executable `{command}`"))
}

fn executable_from_tar<R: Read>(reader: R, command: &str) -> Result<Vec<u8>, String> {
    let mut archive = tar::Archive::new(reader);
    let mut best: Option<(usize, Vec<u8>)> = None;
    for entry in archive.entries().map_err(|error| error.to_string())? {
        let mut entry = entry.map_err(|error| error.to_string())?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let path = entry.path().map_err(|error| error.to_string())?;
        if path.components().any(|component| {
            !matches!(
                component,
                std::path::Component::Normal(_) | std::path::Component::CurDir
            )
        }) || path.file_name().and_then(|name| name.to_str()) != Some(command)
        {
            continue;
        }
        let depth = path.components().count();
        let contents = read_bounded(&mut entry)?;
        if best
            .as_ref()
            .is_none_or(|(best_depth, _)| depth < *best_depth)
        {
            best = Some((depth, contents));
        }
    }
    best.map(|(_, bytes)| bytes)
        .ok_or_else(|| format!("archive does not contain executable `{command}`"))
}

fn read_bounded(reader: &mut impl Read) -> Result<Vec<u8>, String> {
    let mut contents = Vec::new();
    reader
        .take(MAX_ARCHIVE_EXECUTABLE_BYTES + 1)
        .read_to_end(&mut contents)
        .map_err(|error| error.to_string())?;
    if contents.len() as u64 > MAX_ARCHIVE_EXECUTABLE_BYTES {
        return Err("archive executable exceeds the configured size limit".to_owned());
    }
    Ok(contents)
}

fn process_failure(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    if stderr.is_empty() {
        format!("process exited with {}", output.status)
    } else {
        stderr
    }
}
