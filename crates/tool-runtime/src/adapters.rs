use std::{
    io::ErrorKind,
    path::{Path, PathBuf},
};

use async_trait::async_trait;
use tokio::{fs, process::Command};
use uuid::Uuid;

use crate::{
    Downloader, InstallationLockStore, PortError, ProcessProbe, ToolFilesystem,
    ToolInstallationLock,
};

#[derive(Clone)]
pub struct HttpDownloader {
    client: reqwest::Client,
}

impl HttpDownloader {
    pub fn new(client: reqwest::Client) -> Self {
        Self { client }
    }
}

#[async_trait]
impl Downloader for HttpDownloader {
    async fn fetch(&self, url: &str) -> Result<Vec<u8>, PortError> {
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(port_error)?
            .error_for_status()
            .map_err(port_error)?;
        response
            .bytes()
            .await
            .map(|bytes| bytes.to_vec())
            .map_err(port_error)
    }
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
        self.managed_root
            .join(&lock.tool_id)
            .join("versions")
            .join(&lock.version)
            .join("installation-lock.json")
    }
}

#[async_trait]
impl InstallationLockStore for FileInstallationLockStore {
    async fn load_current(&self, tool_id: &str) -> Result<Option<ToolInstallationLock>, PortError> {
        let path = self.current_path(tool_id);
        let bytes = match fs::read(&path).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(port_error(error)),
        };
        serde_json::from_slice(&bytes).map(Some).map_err(port_error)
    }

    async fn commit_current(&self, lock: &ToolInstallationLock) -> Result<(), PortError> {
        let bytes = serde_json::to_vec_pretty(lock).map_err(port_error)?;
        atomic_write(&self.version_lock_path(lock), &bytes).await?;
        atomic_write(&self.current_path(&lock.tool_id), &bytes).await
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
