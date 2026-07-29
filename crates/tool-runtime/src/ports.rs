use std::path::{Path, PathBuf};

use async_trait::async_trait;

use crate::{CancellationToken, PortError, ToolInstallationLock};

#[async_trait]
pub trait Downloader: Send + Sync {
    async fn fetch(&self, url: &str) -> Result<Vec<u8>, PortError>;
}

#[async_trait]
pub trait ToolFilesystem: Send + Sync {
    async fn create_dir_all(&self, path: &Path) -> Result<(), PortError>;
    async fn write_file(&self, path: &Path, bytes: &[u8]) -> Result<(), PortError>;
    async fn read_file(&self, path: &Path) -> Result<Vec<u8>, PortError>;
    async fn set_executable(&self, _path: &Path) -> Result<(), PortError> {
        Ok(())
    }
    async fn canonicalize(&self, path: &Path) -> Result<PathBuf, PortError>;
    async fn rename(&self, from: &Path, to: &Path) -> Result<(), PortError>;
    async fn remove_dir_all(&self, path: &Path) -> Result<(), PortError>;
}

#[async_trait]
pub trait ProcessProbe: Send + Sync {
    async fn probe(&self, executable: &Path, args: &[String]) -> Result<(), PortError>;
}

pub trait InstallationLockGuard: Send {}

struct NoopInstallationLockGuard;
impl InstallationLockGuard for NoopInstallationLockGuard {}

#[async_trait]
pub trait InstallationLockStore: Send + Sync {
    async fn acquire_install_lock(
        &self,
        _tool_id: &str,
    ) -> Result<Box<dyn InstallationLockGuard>, PortError> {
        Ok(Box::new(NoopInstallationLockGuard))
    }

    async fn load_current(&self, tool_id: &str) -> Result<Option<ToolInstallationLock>, PortError>;

    async fn load_version(
        &self,
        tool_id: &str,
        version: &str,
    ) -> Result<Option<ToolInstallationLock>, PortError> {
        Ok(self
            .load_current(tool_id)
            .await?
            .filter(|lock| lock.version == version))
    }

    /// Commits the current pointer at a cancellation-aware linearization
    /// boundary. Once this returns `Ok`, a later cancellation is considered
    /// too late to roll the committed version back.
    async fn commit_current(
        &self,
        lock: &ToolInstallationLock,
        cancellation: &CancellationToken,
    ) -> Result<(), PortError>;
}
