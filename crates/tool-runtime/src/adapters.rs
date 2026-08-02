use std::{
    io::ErrorKind,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use async_trait::async_trait;
use reqwest::header::LOCATION;
use tokio::{fs, process::Command};
use url::Url;
use uuid::Uuid;

use crate::{
    CancellationToken, Downloader, InstallationLockGuard, InstallationLockStore, PortError,
    ProcessProbe, ToolFilesystem, ToolInstallationLock, validate_distribution_url,
};

#[derive(Clone)]
pub struct HttpDownloader {
    resolver: Arc<dyn HostResolver>,
    connect_timeout: Duration,
    request_timeout: Duration,
    max_bytes: usize,
}

impl HttpDownloader {
    pub fn new(connect_timeout: Duration, request_timeout: Duration) -> Self {
        Self::with_resolver(
            Arc::new(SystemHostResolver),
            connect_timeout,
            request_timeout,
            256 * 1024 * 1024,
        )
    }

    pub fn with_resolver(
        resolver: Arc<dyn HostResolver>,
        connect_timeout: Duration,
        request_timeout: Duration,
        max_bytes: usize,
    ) -> Self {
        Self {
            resolver,
            connect_timeout,
            request_timeout,
            max_bytes,
        }
    }
}

#[async_trait]
pub trait HostResolver: Send + Sync {
    async fn resolve(&self, host: &str, port: u16) -> Result<Vec<IpAddr>, PortError>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SystemHostResolver;

#[async_trait]
impl HostResolver for SystemHostResolver {
    async fn resolve(&self, host: &str, port: u16) -> Result<Vec<IpAddr>, PortError> {
        tokio::net::lookup_host((host, port))
            .await
            .map(|addresses| addresses.map(|address| address.ip()).collect())
            .map_err(|_| PortError::new("download host resolution failed"))
    }
}

#[async_trait]
impl Downloader for HttpDownloader {
    async fn fetch(&self, url: &str) -> Result<Vec<u8>, PortError> {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
        validate_distribution_url(url).map_err(PortError::new)?;
        let initial = Url::parse(url).map_err(|_| PortError::new("download URL is invalid"))?;
        let initial_host = initial
            .host_str()
            .ok_or_else(|| PortError::new("download URL must contain a host"))?
            .to_ascii_lowercase();
        let mut current = initial;
        let mut redirect_count = 0_u8;

        let mut response = loop {
            validate_redirect_target(&initial_host, &current, redirect_count)?;
            let host = current
                .host_str()
                .ok_or_else(|| PortError::new("download URL must contain a host"))?;
            let port = current
                .port_or_known_default()
                .ok_or_else(|| PortError::new("download URL port is invalid"))?;
            let addresses = self.resolver.resolve(host, port).await?;
            if addresses.is_empty()
                || addresses
                    .iter()
                    .any(|address| !is_allowed_download_address(host, *address))
            {
                return Err(PortError::new(
                    "download host must resolve only to public IP addresses",
                ));
            }
            let socket_addresses = addresses
                .iter()
                .map(|address| SocketAddr::new(*address, port))
                .collect::<Vec<_>>();
            let client = reqwest::Client::builder()
                .https_only(true)
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(self.connect_timeout)
                .timeout(self.request_timeout)
                .resolve_to_addrs(host, &socket_addresses)
                .build()
                .map_err(|_| PortError::new("secure HTTPS client setup failed"))?;
            let response = client
                .get(current.clone())
                .send()
                .await
                .map_err(|_| PortError::new("HTTPS download failed"))?;
            if !response.status().is_redirection() {
                break response;
            }
            if redirect_count >= 5 {
                return Err(PortError::new("download redirect limit exceeded"));
            }
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| PortError::new("download redirect is missing a valid location"))?;
            current = current
                .join(location)
                .map_err(|_| PortError::new("download redirect location is invalid"))?;
            redirect_count += 1;
        };

        response = response
            .error_for_status()
            .map_err(|_| PortError::new("HTTPS download returned an error status"))?;
        if response
            .content_length()
            .is_some_and(|length| length > self.max_bytes as u64)
        {
            return Err(PortError::new("download exceeds the configured size limit"));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| PortError::new("HTTPS download body failed"))?
        {
            if bytes.len().saturating_add(chunk.len()) > self.max_bytes {
                return Err(PortError::new("download exceeds the configured size limit"));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
}

fn validate_redirect_target(
    initial_host: &str,
    target: &Url,
    redirect_count: u8,
) -> Result<(), PortError> {
    let host = target
        .host_str()
        .ok_or_else(|| PortError::new("download redirect must contain a DNS host"))?;
    let normalized_host = host.trim_end_matches('.').to_ascii_lowercase();
    let credentials_are_empty = target.username().is_empty() && target.password().is_none();
    let standard_https_port = target.port_or_known_default() == Some(443);
    if target.scheme() != "https"
        || normalized_host.len() != host.len()
        || !credentials_are_empty
        || target.fragment().is_some()
        || !standard_https_port
    {
        return Err(PortError::new("download redirect target is not allowed"));
    }
    if redirect_count == 0 {
        return Ok(());
    }
    let trusted_github_release = initial_host == "github.com"
        && matches!(
            normalized_host.as_str(),
            "github.com" | "release-assets.githubusercontent.com"
        );
    if !trusted_github_release {
        return Err(PortError::new("download redirect target is not allowed"));
    }
    Ok(())
}

fn is_allowed_download_address(host: &str, address: IpAddr) -> bool {
    is_public_ip(address)
        || (is_trusted_github_download_host(host) && is_proxy_synthetic_ip(address))
}

fn is_trusted_github_download_host(host: &str) -> bool {
    matches!(
        host.trim_end_matches('.').to_ascii_lowercase().as_str(),
        "github.com" | "release-assets.githubusercontent.com"
    )
}

fn is_proxy_synthetic_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let [a, b, _, _] = address.octets();
            a == 198 && (b == 18 || b == 19)
        }
        IpAddr::V6(_) => false,
    }
}

fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => is_public_ipv4(address),
        IpAddr::V6(address) => is_public_ipv6(address),
    }
}

fn is_public_ipv4(address: Ipv4Addr) -> bool {
    let [a, b, c, _] = address.octets();
    !(a == 0
        || a == 10
        || a == 127
        || a >= 224
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 0 && c == 0)
        || (a == 192 && b == 0 && c == 2)
        || (a == 192 && b == 168)
        || (a == 198 && (b == 18 || b == 19))
        || (a == 198 && b == 51 && c == 100)
        || (a == 203 && b == 0 && c == 113))
}

fn is_public_ipv6(address: Ipv6Addr) -> bool {
    let segments = address.segments();
    if let Some(address) = address.to_ipv4_mapped() {
        return is_public_ipv4(address);
    }
    !(address.is_unspecified()
        || address.is_loopback()
        || address.is_multicast()
        || (segments[0] & 0xfe00) == 0xfc00
        || (segments[0] & 0xffc0) == 0xfe80
        || (segments[0] == 0x2001 && segments[1] == 0x0db8))
}

#[derive(Clone, Copy, Debug, Default)]
pub struct LocalToolFilesystem;

#[async_trait]
impl ToolFilesystem for LocalToolFilesystem {
    async fn create_dir_all(&self, path: &Path) -> Result<(), PortError> {
        fs::create_dir_all(path).await.map_err(port_error)
    }

    async fn write_file(&self, path: &Path, bytes: &[u8]) -> Result<(), PortError> {
        fs::write(path, bytes).await.map_err(port_error)
    }

    async fn read_file(&self, path: &Path) -> Result<Vec<u8>, PortError> {
        fs::read(path).await.map_err(port_error)
    }

    async fn set_executable(&self, path: &Path) -> Result<(), PortError> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mut permissions = fs::metadata(path).await.map_err(port_error)?.permissions();
            permissions.set_mode(0o700);
            fs::set_permissions(path, permissions)
                .await
                .map_err(port_error)?;
        }
        #[cfg(not(unix))]
        let _ = path;
        Ok(())
    }

    async fn canonicalize(&self, path: &Path) -> Result<PathBuf, PortError> {
        fs::canonicalize(path).await.map_err(port_error)
    }

    async fn rename(&self, from: &Path, to: &Path) -> Result<(), PortError> {
        fs::rename(from, to).await.map_err(port_error)
    }

    async fn remove_dir_all(&self, path: &Path) -> Result<(), PortError> {
        match fs::remove_dir_all(path).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(error) => Err(port_error(error)),
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct CommandProcessProbe;

#[async_trait]
impl ProcessProbe for CommandProcessProbe {
    async fn probe(&self, executable: &Path, args: &[String]) -> Result<(), PortError> {
        if !executable.is_absolute() {
            return Err(PortError::new("probe executable path must be absolute"));
        }
        let status = Command::new(executable)
            .args(args)
            .kill_on_drop(true)
            .status()
            .await
            .map_err(port_error)?;
        if status.success() {
            Ok(())
        } else {
            Err(PortError::new(format!("probe exited with status {status}")))
        }
    }
}

#[derive(Clone, Debug)]
pub struct FileInstallationLockStore {
    managed_root: PathBuf,
}

impl FileInstallationLockStore {
    pub fn new(managed_root: PathBuf) -> Self {
        Self { managed_root }
    }

    fn current_path(&self, tool_id: &str) -> PathBuf {
        self.managed_root.join(tool_id).join("current.json")
    }

    fn version_lock_path(&self, lock: &ToolInstallationLock) -> PathBuf {
        self.version_path(&lock.tool_id, &lock.version)
    }

    fn version_path(&self, tool_id: &str, version: &str) -> PathBuf {
        self.managed_root
            .join(tool_id)
            .join("versions")
            .join(version)
            .join("installation-lock.json")
    }
}

#[async_trait]
impl InstallationLockStore for FileInstallationLockStore {
    async fn acquire_install_lock(
        &self,
        tool_id: &str,
    ) -> Result<Box<dyn InstallationLockGuard>, PortError> {
        let lock_dir = self.managed_root.join(tool_id);
        fs::create_dir_all(&lock_dir).await.map_err(port_error)?;
        let lock_path = lock_dir.join("install.lock");
        let file = tokio::task::spawn_blocking(move || {
            let file = std::fs::OpenOptions::new()
                .create(true)
                .read(true)
                .write(true)
                .truncate(false)
                .open(lock_path)?;
            fs2::FileExt::lock_exclusive(&file)?;
            Ok::<_, std::io::Error>(file)
        })
        .await
        .map_err(port_error)?
        .map_err(port_error)?;
        Ok(Box::new(FileInstallGuard(file)))
    }

    async fn load_current(&self, tool_id: &str) -> Result<Option<ToolInstallationLock>, PortError> {
        let path = self.current_path(tool_id);
        let bytes = match fs::read(&path).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(port_error(error)),
        };
        serde_json::from_slice(&bytes).map(Some).map_err(port_error)
    }

    async fn load_version(
        &self,
        tool_id: &str,
        version: &str,
    ) -> Result<Option<ToolInstallationLock>, PortError> {
        let path = self.version_path(tool_id, version);
        let bytes = match fs::read(&path).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(port_error(error)),
        };
        serde_json::from_slice(&bytes).map(Some).map_err(port_error)
    }

    async fn commit_current(
        &self,
        lock: &ToolInstallationLock,
        cancellation: &CancellationToken,
    ) -> Result<(), PortError> {
        if cancellation.is_cancelled() {
            return Err(PortError::new(
                "installation cancelled before current pointer commit",
            ));
        }
        let bytes = serde_json::to_vec_pretty(lock).map_err(port_error)?;
        atomic_write(&self.version_lock_path(lock), &bytes).await?;
        if cancellation.is_cancelled() {
            return Err(PortError::new(
                "installation cancelled before current pointer commit",
            ));
        }
        atomic_write(&self.current_path(&lock.tool_id), &bytes).await
    }
}

struct FileInstallGuard(std::fs::File);

impl InstallationLockGuard for FileInstallGuard {}

impl Drop for FileInstallGuard {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.0);
    }
}

async fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), PortError> {
    let parent = path
        .parent()
        .ok_or_else(|| PortError::new("lock path has no parent directory"))?;
    fs::create_dir_all(parent).await.map_err(port_error)?;
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| PortError::new("lock path filename is not valid UTF-8"))?;
    let temporary = parent.join(format!(".{filename}.{}.tmp", Uuid::new_v4()));
    let mut file = fs::File::create(&temporary).await.map_err(port_error)?;
    use tokio::io::AsyncWriteExt;
    file.write_all(bytes).await.map_err(port_error)?;
    file.sync_all().await.map_err(port_error)?;
    drop(file);
    if let Err(error) = fs::rename(&temporary, path).await {
        let _ = fs::remove_file(&temporary).await;
        return Err(port_error(error));
    }
    Ok(())
}

fn port_error(error: impl std::fmt::Display) -> PortError {
    PortError::new(error.to_string())
}
