use std::{
    collections::BTreeMap,
    io::{Cursor, Read},
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

use async_trait::async_trait;
use sha2::{Digest, Sha256};
use tokio::{process::Command, sync::Mutex as AsyncMutex};
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

/// Installs managed Runtime bytes into an immutable, content-addressed Host directory.
/// It never mutates PATH or a user-global executable. `resolve` falls back to PATH only
/// for explicitly external Runtime declarations that did not stage managed bytes.
pub struct ContentAddressedRuntimeHost {
    root: PathBuf,
    runtime_id: String,
    version: String,
    target: String,
    content_digest: String,
    staged_entrypoint: Mutex<Option<PathBuf>>,
}

/// Resolves the pinned Node.js runtime used exclusively by sandboxed Plugin
/// Workers. The runtime is checksum verified and stored below a Host-owned,
/// content-addressed directory; user PATH is never an authority for production
/// activation.
pub struct PluginWorkerRuntimeProvider {
    data_root: PathBuf,
    root: PathBuf,
    resolved: AsyncMutex<Option<PathBuf>>,
}

impl PluginWorkerRuntimeProvider {
    pub fn new(data_root: PathBuf) -> Self {
        Self {
            root: data_root.join("plugins/worker-runtimes"),
            data_root,
            resolved: AsyncMutex::new(None),
        }
    }

    fn prepare_storage(&self) -> Result<(), PluginError> {
        std::fs::create_dir_all(&self.root).map_err(|error| {
            PluginError::runtime_install_failed("vibex-plugin-worker-node", error.to_string())
        })?;
        prepare_macos_managed_runtime_storage(&self.data_root, &self.root)
            .map_err(|error| PluginError::runtime_install_failed("vibex-plugin-worker-node", error))
    }

    pub async fn resolve(&self) -> Result<PathBuf, PluginError> {
        self.prepare_storage()?;
        let mut resolved = self.resolved.lock().await;
        if let Some(path) = resolved.as_ref()
            && worker_node_is_healthy(path).await
        {
            return Ok(path.clone());
        }
        let runtime = plugin_worker_node_runtime().ok_or_else(|| {
            PluginError::runtime_not_ready(
                "vibex-plugin-worker-node",
                format!(
                    "VibeX has no pinned Plugin Worker Node.js artifact for {}-{}",
                    std::env::consts::OS,
                    std::env::consts::ARCH
                ),
            )
        })?;
        let host = ContentAddressedRuntimeHost::new(self.root.clone(), &runtime)?;
        let expected = host.artifact_directory().join(&runtime.command);
        if worker_node_is_healthy(&expected).await {
            *resolved = Some(expected.clone());
            return Ok(expected);
        }
        if tokio::fs::try_exists(&expected).await.unwrap_or(false) {
            let invalid = expected.with_extension(format!("invalid-{}", uuid::Uuid::new_v4()));
            tokio::fs::rename(&expected, invalid)
                .await
                .map_err(|error| {
                    PluginError::runtime_install_failed(&runtime.id, error.to_string())
                })?;
        }
        let installation = GlobalRuntimeInstaller::new(&host)
            .install("vibex.host", &runtime)
            .await?;
        if !worker_node_is_healthy(&installation.executable_path).await {
            return Err(PluginError::runtime_not_ready(
                &runtime.id,
                "the checksum-verified Node.js artifact failed its version probe",
            ));
        }
        *resolved = Some(installation.executable_path.clone());
        Ok(installation.executable_path)
    }
}

const PLUGIN_WORKER_NODE_VERSION: &str = "22.22.3";

fn plugin_worker_node_runtime() -> Option<RuntimeContribution> {
    let (target, extension, archive_sha256) = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => (
            "darwin-arm64",
            "tar.gz",
            "0da7ff74ef8611328c8212f17943368713a2ad953fb7d89a8c8a0eae87c23207",
        ),
        ("macos", "x86_64") => (
            "darwin-x64",
            "tar.gz",
            "45830ba752fa0d892c6dcd640946669801293cac820a33591ded40ac075198ec",
        ),
        ("linux", "aarch64") => (
            "linux-arm64",
            "tar.gz",
            "cc8bc82b2dd0b595c3b95a4c3c9c8c350907cff011afbdee3d1379e812e1e3e3",
        ),
        ("linux", "x86_64") => (
            "linux-x64",
            "tar.gz",
            "c7a10d6816da8eaaa7534dd73c71c6e2b2c391dbbf845e364902d156615dd1b8",
        ),
        ("windows", "aarch64") => (
            "win-arm64",
            "zip",
            "00be129a09e8872cd52d3bb8bba12412c5733d2224123a482a2dca4a6fbf2586",
        ),
        ("windows", "x86_64") => (
            "win-x64",
            "zip",
            "6c8d54f635feff4df76c2ca80f45332eb2ff57d25226edce36592e51a177ee33",
        ),
        _ => return None,
    };
    let command = if cfg!(windows) { "node.exe" } else { "node" };
    let filename = format!("node-v{PLUGIN_WORKER_NODE_VERSION}-{target}.{extension}");
    Some(RuntimeContribution {
        id: "vibex-plugin-worker-node".to_owned(),
        command: command.to_owned(),
        version: Some(PLUGIN_WORKER_NODE_VERSION.to_owned()),
        target: target.to_owned(),
        content_digest: format!("sha256:{archive_sha256}"),
        probe: vec!["--version".to_owned()],
        install: RuntimeInstall::Archive {
            url: format!("https://nodejs.org/dist/v{PLUGIN_WORKER_NODE_VERSION}/{filename}"),
            sha256: Some(archive_sha256.to_owned()),
        },
    })
}

async fn worker_node_is_healthy(path: &Path) -> bool {
    if !tokio::fs::metadata(path)
        .await
        .is_ok_and(|metadata| metadata.is_file())
    {
        return false;
    }
    probe_executable(path, &["--version".to_owned()])
        .await
        .is_ok_and(|output| output.trim() == format!("v{PLUGIN_WORKER_NODE_VERSION}"))
}

impl ContentAddressedRuntimeHost {
    pub fn new(root: PathBuf, runtime: &RuntimeContribution) -> Result<Self, PluginError> {
        for (label, value) in [
            ("runtime id", runtime.id.as_str()),
            (
                "runtime version",
                runtime.version.as_deref().unwrap_or("unversioned"),
            ),
            ("runtime target", runtime.target.as_str()),
        ] {
            if !safe_runtime_segment(value) {
                return Err(PluginError::runtime_not_ready(
                    &runtime.id,
                    format!("{label} is not safe for managed storage"),
                ));
            }
        }
        if !matches!(runtime.install, RuntimeInstall::Existing)
            && !runtime.content_digest.starts_with("sha256:")
        {
            return Err(PluginError::runtime_not_ready(
                &runtime.id,
                "managed Runtime requires a sha256 content digest",
            ));
        }
        Ok(Self {
            root,
            runtime_id: runtime.id.clone(),
            version: runtime
                .version
                .clone()
                .unwrap_or_else(|| "unversioned".to_owned()),
            target: runtime.target.clone(),
            content_digest: runtime.content_digest.clone(),
            staged_entrypoint: Mutex::new(None),
        })
    }

    fn artifact_directory(&self) -> PathBuf {
        let digest = self
            .content_digest
            .strip_prefix("sha256:")
            .unwrap_or("external");
        self.root
            .join(&self.runtime_id)
            .join(&self.version)
            .join(&self.target)
            .join(digest)
    }

    async fn publish(&self, command: &str, bytes: &[u8]) -> Result<(), String> {
        validate_global_command(command)?;
        let directory = self.artifact_directory();
        let parent = directory
            .parent()
            .ok_or_else(|| "managed Runtime artifact has no parent directory".to_owned())?;
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| error.to_string())?;
        let artifact_name = directory
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "managed Runtime artifact name is invalid".to_owned())?;
        let staging_directory = parent.join(format!(
            ".{artifact_name}.incoming-{}",
            uuid::Uuid::new_v4()
        ));
        tokio::fs::create_dir(&staging_directory)
            .await
            .map_err(|error| error.to_string())?;
        let target = directory.join(command);
        let staging = staging_directory.join(command);
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
        clear_macos_runtime_quarantine(&staging_directory)?;
        clear_macos_runtime_quarantine(&staging)?;
        if tokio::fs::try_exists(&target)
            .await
            .map_err(|error| error.to_string())?
        {
            let existing = tokio::fs::read(&target)
                .await
                .map_err(|error| error.to_string())?;
            if existing != bytes {
                let _ = tokio::fs::remove_dir_all(&staging_directory).await;
                return Err("content-addressed Runtime path contains different bytes".to_owned());
            }
            #[cfg(target_os = "macos")]
            {
                swap_macos_artifact_directories(&staging_directory, &directory)?;
                let _ = tokio::fs::remove_dir_all(&staging_directory).await;
            }
            #[cfg(not(target_os = "macos"))]
            tokio::fs::remove_dir_all(&staging_directory)
                .await
                .map_err(|error| error.to_string())?;
        } else {
            match tokio::fs::rename(&staging_directory, &directory).await {
                Ok(()) => {}
                Err(_) if tokio::fs::try_exists(&target).await.unwrap_or(false) => {
                    let existing = tokio::fs::read(&target)
                        .await
                        .map_err(|read_error| read_error.to_string())?;
                    let _ = tokio::fs::remove_dir_all(&staging_directory).await;
                    if existing != bytes {
                        return Err(
                            "content-addressed Runtime path contains different bytes".to_owned()
                        );
                    }
                }
                Err(error) => return Err(error.to_string()),
            }
        }
        *self
            .staged_entrypoint
            .lock()
            .map_err(|error| error.to_string())? = Some(target);
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn clear_macos_runtime_quarantine(executable: &Path) -> Result<(), String> {
    const QUARANTINE_ATTRIBUTE: &str = "com.apple.quarantine";
    if xattr::get(executable, QUARANTINE_ATTRIBUTE)
        .map_err(|error| format!("failed to inspect managed Runtime quarantine: {error}"))?
        .is_some()
    {
        xattr::remove(executable, QUARANTINE_ATTRIBUTE)
            .map_err(|error| format!("failed to clear managed Runtime quarantine: {error}"))?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn prepare_macos_managed_runtime_storage(
    data_root: &Path,
    runtime_root: &Path,
) -> Result<(), String> {
    if !runtime_root.starts_with(data_root) {
        return Err("managed Runtime root is outside the Host data directory".to_owned());
    }

    let mut ancestor = Some(runtime_root);
    while let Some(path) = ancestor {
        clear_macos_runtime_quarantine(path)?;
        if path == data_root {
            break;
        }
        ancestor = path.parent();
    }
    clear_macos_quarantine_tree(runtime_root)
}

#[cfg(target_os = "macos")]
fn clear_macos_quarantine_tree(root: &Path) -> Result<(), String> {
    for entry in std::fs::read_dir(root)
        .map_err(|error| format!("failed to inspect managed Runtime storage: {error}"))?
    {
        let entry =
            entry.map_err(|error| format!("failed to inspect managed Runtime storage: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("failed to inspect managed Runtime storage: {error}"))?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        clear_macos_runtime_quarantine(&path)?;
        if file_type.is_dir() {
            clear_macos_quarantine_tree(&path)?;
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn swap_macos_artifact_directories(staging: &Path, published: &Path) -> Result<(), String> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};

    let staging = CString::new(staging.as_os_str().as_bytes())
        .map_err(|_| "managed Runtime staging path contains a null byte".to_owned())?;
    let published = CString::new(published.as_os_str().as_bytes())
        .map_err(|_| "managed Runtime published path contains a null byte".to_owned())?;
    // SAFETY: both C strings live for the duration of the call and point to
    // directories on the same filesystem. RENAME_SWAP preserves a valid
    // published artifact path throughout the replacement.
    let result =
        unsafe { libc::renamex_np(staging.as_ptr(), published.as_ptr(), libc::RENAME_SWAP) };
    if result == 0 {
        Ok(())
    } else {
        Err(format!(
            "failed to atomically replace managed Runtime artifact: {}",
            std::io::Error::last_os_error()
        ))
    }
}

#[cfg(not(target_os = "macos"))]
fn clear_macos_runtime_quarantine(_executable: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn prepare_macos_managed_runtime_storage(
    _data_root: &Path,
    _runtime_root: &Path,
) -> Result<(), String> {
    Ok(())
}

#[async_trait]
impl GlobalRuntimeHost for ContentAddressedRuntimeHost {
    async fn run(&self, _process: RuntimeProcess) -> Result<(), String> {
        Err("v4 managed Runtime does not permit global package-manager installers".to_owned())
    }

    async fn install_binary(
        &self,
        _runtime_id: &str,
        command: &str,
        url: &str,
        sha256: Option<&str>,
    ) -> Result<(), String> {
        let bytes = download_and_verify(url, sha256).await?;
        self.publish(command, &bytes).await
    }

    async fn install_archive(
        &self,
        _runtime_id: &str,
        command: &str,
        url: &str,
        sha256: Option<&str>,
    ) -> Result<(), String> {
        let bytes = download_and_verify(url, sha256).await?;
        let executable = executable_from_archive(&bytes, url, command)?;
        self.publish(command, &executable).await
    }

    async fn resolve(&self, command: &str) -> Result<PathBuf, String> {
        if let Some(path) = self
            .staged_entrypoint
            .lock()
            .map_err(|error| error.to_string())?
            .clone()
        {
            return Ok(path);
        }
        utils::shell::resolve_executable_path(command)
            .await
            .ok_or_else(|| format!("external command `{command}` was not found"))
    }

    async fn probe(&self, executable: &Path, args: &[String]) -> Result<String, String> {
        probe_executable(executable, args).await
    }
}

fn safe_runtime_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

impl<'a, H: GlobalRuntimeHost + ?Sized> GlobalRuntimeInstaller<'a, H> {
    pub fn new(host: &'a H) -> Self {
        Self { host }
    }

    pub async fn install(
        &self,
        plugin_id: &str,
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
                if let Some(process) = install_process(runtime) {
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
            target: runtime.target.clone(),
            content_digest: runtime.content_digest.clone(),
            executable_path: executable,
            ownership: if matches!(runtime.install, RuntimeInstall::Existing) {
                "external".to_owned()
            } else {
                "managed".to_owned()
            },
            installer: runtime_install_key(&runtime.install).to_owned(),
            probe: runtime.probe.clone(),
            referenced_plugins: vec![plugin_id.to_owned()],
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
    }
}

fn install_process(runtime: &RuntimeContribution) -> Option<RuntimeProcess> {
    let environment = inherited_runtime_environment();
    let process = match &runtime.install {
        RuntimeInstall::Existing => return None,
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
        RuntimeInstall::Binary { .. } | RuntimeInstall::Archive { .. } => return None,
    };
    Some(process)
}

pub fn inherited_runtime_environment() -> BTreeMap<String, String> {
    std::env::vars().collect()
}

async fn probe_executable(executable: &Path, args: &[String]) -> Result<String, String> {
    probe_executable_with_timeout(executable, args, Duration::from_secs(15)).await
}

async fn probe_executable_with_timeout(
    executable: &Path,
    args: &[String],
    timeout: Duration,
) -> Result<String, String> {
    let mut command = Command::new(executable);
    command.args(args).kill_on_drop(true);
    let output = tokio::time::timeout(timeout, command.output())
        .await
        .map_err(|_| {
            format!(
                "Runtime probe timed out after {} seconds",
                timeout.as_secs_f64()
            )
        })?
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(process_failure(&output));
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    Ok(if stdout.is_empty() { stderr } else { stdout })
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

#[cfg(test)]
mod tests {
    use super::*;

    fn contribution(version: &str, digest: &str) -> RuntimeContribution {
        RuntimeContribution {
            id: "shared-cli".to_owned(),
            command: "shared".to_owned(),
            version: Some(version.to_owned()),
            target: "test-target".to_owned(),
            content_digest: format!("sha256:{digest}"),
            probe: vec!["--version".to_owned()],
            install: RuntimeInstall::Binary {
                url: "https://example.invalid/shared".to_owned(),
                sha256: Some(digest.to_owned()),
            },
        }
    }

    #[tokio::test]
    async fn managed_runtime_versions_publish_to_distinct_immutable_paths() {
        let root = tempfile::tempdir().unwrap();
        let first = ContentAddressedRuntimeHost::new(
            root.path().to_path_buf(),
            &contribution("1.0.0", "one"),
        )
        .unwrap();
        let second = ContentAddressedRuntimeHost::new(
            root.path().to_path_buf(),
            &contribution("2.0.0", "two"),
        )
        .unwrap();

        first.publish("shared", b"version-one").await.unwrap();
        second.publish("shared", b"version-two").await.unwrap();

        let first_path = first.resolve("shared").await.unwrap();
        let second_path = second.resolve("shared").await.unwrap();
        assert_ne!(first_path, second_path);
        assert_eq!(tokio::fs::read(first_path).await.unwrap(), b"version-one");
        assert_eq!(tokio::fs::read(second_path).await.unwrap(), b"version-two");
    }

    #[tokio::test]
    async fn content_addressed_path_refuses_different_bytes() {
        let root = tempfile::tempdir().unwrap();
        let host = ContentAddressedRuntimeHost::new(
            root.path().to_path_buf(),
            &contribution("1.0.0", "same"),
        )
        .unwrap();
        host.publish("shared", b"first").await.unwrap();

        let error = host.publish("shared", b"different").await.unwrap_err();

        assert!(error.contains("different bytes"));
    }

    #[tokio::test]
    async fn concurrent_identical_runtime_publishes_converge() {
        let root = tempfile::tempdir().unwrap();
        let first = ContentAddressedRuntimeHost::new(
            root.path().to_path_buf(),
            &contribution("1.0.0", "same"),
        )
        .unwrap();
        let second = ContentAddressedRuntimeHost::new(
            root.path().to_path_buf(),
            &contribution("1.0.0", "same"),
        )
        .unwrap();

        let (first_result, second_result) = tokio::join!(
            first.publish("shared", b"verified-runtime"),
            second.publish("shared", b"verified-runtime")
        );

        first_result.unwrap();
        second_result.unwrap();
        assert_eq!(
            tokio::fs::read(first.artifact_directory().join("shared"))
                .await
                .unwrap(),
            b"verified-runtime"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runtime_probe_times_out_instead_of_blocking_host_startup() {
        let error = probe_executable_with_timeout(
            Path::new("/bin/sh"),
            &["-c".to_owned(), "sleep 5".to_owned()],
            Duration::from_millis(20),
        )
        .await
        .unwrap_err();

        assert!(error.contains("timed out"));
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn republishing_verified_runtime_clears_macos_quarantine() {
        use std::os::unix::fs::MetadataExt;

        let root = tempfile::tempdir().unwrap();
        let host = ContentAddressedRuntimeHost::new(
            root.path().to_path_buf(),
            &contribution("1.0.0", "verified"),
        )
        .unwrap();
        let directory = host.artifact_directory();
        tokio::fs::create_dir_all(&directory).await.unwrap();
        let executable = directory.join("shared");
        tokio::fs::write(&executable, b"verified-runtime")
            .await
            .unwrap();
        xattr::set(&directory, "com.apple.quarantine", b"0081;0;VibeX;").unwrap();
        xattr::set(&executable, "com.apple.quarantine", b"0081;0;VibeX;").unwrap();
        let quarantined_directory_inode = std::fs::metadata(&directory).unwrap().ino();
        let quarantined_inode = std::fs::metadata(&executable).unwrap().ino();

        host.publish("shared", b"verified-runtime").await.unwrap();

        assert_eq!(
            xattr::get(&executable, "com.apple.quarantine").unwrap(),
            None,
            "a checksum-verified managed Runtime must be launchable by the Host"
        );
        assert_eq!(
            xattr::get(&directory, "com.apple.quarantine").unwrap(),
            None,
            "the immutable artifact directory must not retain download quarantine"
        );
        assert_ne!(
            std::fs::metadata(&directory).unwrap().ino(),
            quarantined_directory_inode,
            "an artifact directory already denied by AppleSystemPolicy must be replaced"
        );
        assert_ne!(
            std::fs::metadata(&executable).unwrap().ino(),
            quarantined_inode,
            "an inode already denied by AppleSystemPolicy must be atomically replaced"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn worker_runtime_storage_clears_quarantine_from_owned_ancestors() {
        let data = tempfile::tempdir().unwrap();
        let provider = PluginWorkerRuntimeProvider::new(data.path().to_path_buf());
        std::fs::create_dir_all(&provider.root).unwrap();
        let plugins_root = data.path().join("plugins");
        for path in [data.path(), plugins_root.as_path(), provider.root.as_path()] {
            xattr::set(path, "com.apple.quarantine", b"0081;0;VibeX;").unwrap();
        }

        provider.prepare_storage().unwrap();

        for path in [data.path(), plugins_root.as_path(), provider.root.as_path()] {
            assert_eq!(
                xattr::get(path, "com.apple.quarantine").unwrap(),
                None,
                "managed Plugin Worker storage must not inherit App-bundle quarantine"
            );
        }
    }

    #[test]
    fn plugin_worker_node_catalog_is_pinned_for_the_current_supported_target() {
        let runtime = plugin_worker_node_runtime().expect("supported desktop target");
        assert_eq!(runtime.id, "vibex-plugin-worker-node");
        assert_eq!(runtime.version.as_deref(), Some(PLUGIN_WORKER_NODE_VERSION));
        assert!(runtime.content_digest.starts_with("sha256:"));
        assert_eq!(runtime.content_digest.len(), "sha256:".len() + 64);
        let RuntimeInstall::Archive { url, sha256 } = runtime.install else {
            panic!("Plugin Worker Node must use the immutable archive installer")
        };
        assert!(url.starts_with("https://nodejs.org/dist/v22.22.3/"));
        assert_eq!(
            sha256.as_deref(),
            runtime.content_digest.strip_prefix("sha256:")
        );
    }
}
