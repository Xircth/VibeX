//! External-effect boundaries for Agent management.
//!
//! Domain services consume these interfaces directly. Production adapters may
//! use HTTP, child processes and the native filesystem; tests provide fakes at
//! exactly these boundaries rather than mocking repositories or domain logic.

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use async_trait::async_trait;
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct BoundaryError {
    pub message: String,
}

impl BoundaryError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegistryFetchResponse {
    pub status: u16,
    pub body: Vec<u8>,
    pub etag: Option<String>,
}

#[async_trait]
pub trait RegistryFetcher: Send + Sync {
    async fn fetch(
        &self,
        url: &str,
        etag: Option<&str>,
    ) -> Result<RegistryFetchResponse, BoundaryError>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallInvocation {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub cwd: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallOutput {
    pub status_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

#[async_trait]
pub trait InstallRunner: Send + Sync {
    async fn run(&self, invocation: InstallInvocation) -> Result<InstallOutput, BoundaryError>;
}

pub trait Clock: Send + Sync {
    fn now(&self) -> DateTime<Utc>;
}

#[derive(Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeFileMetadata {
    pub length: u64,
}

#[async_trait]
pub trait NativeFileSystem: Send + Sync {
    async fn read(&self, path: &Path) -> Result<Option<Vec<u8>>, BoundaryError>;
    async fn write_atomic(&self, path: &Path, bytes: &[u8]) -> Result<(), BoundaryError>;
    async fn remove_file(&self, path: &Path) -> Result<(), BoundaryError> {
        Err(BoundaryError::new(format!(
            "filesystem adapter cannot remove `{}`",
            path.display()
        )))
    }
    async fn write_many_atomic(&self, writes: &[(PathBuf, Vec<u8>)]) -> Result<(), BoundaryError> {
        let mut originals = Vec::with_capacity(writes.len());
        for (path, _) in writes {
            originals.push((path.clone(), self.read(path).await?));
        }
        for (committed, (path, bytes)) in writes.iter().enumerate() {
            if let Err(error) = self.write_atomic(path, bytes).await {
                for (rollback_path, original) in originals[..committed].iter().rev() {
                    if let Some(original) = original {
                        self.write_atomic(rollback_path, original).await?;
                    } else {
                        self.remove_file(rollback_path).await?;
                    }
                }
                return Err(error);
            }
        }
        Ok(())
    }
    async fn metadata(&self, path: &Path) -> Result<Option<NativeFileMetadata>, BoundaryError>;
}

#[derive(Debug, Default)]
pub struct TokioNativeFileSystem;

#[async_trait]
impl NativeFileSystem for TokioNativeFileSystem {
    async fn read(&self, path: &Path) -> Result<Option<Vec<u8>>, BoundaryError> {
        match tokio::fs::read(path).await {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(BoundaryError::new(error.to_string())),
        }
    }

    async fn write_atomic(&self, path: &Path, bytes: &[u8]) -> Result<(), BoundaryError> {
        let parent = path
            .parent()
            .ok_or_else(|| BoundaryError::new("native configuration path has no parent"))?;
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| BoundaryError::new(error.to_string()))?;
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| BoundaryError::new("native configuration path has no file name"))?;
        let temporary = parent.join(format!(".{file_name}.{}.tmp", uuid::Uuid::new_v4()));
        tokio::fs::write(&temporary, bytes)
            .await
            .map_err(|error| BoundaryError::new(error.to_string()))?;
        if let Err(error) = tokio::fs::rename(&temporary, path).await {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(BoundaryError::new(error.to_string()));
        }
        Ok(())
    }

    async fn remove_file(&self, path: &Path) -> Result<(), BoundaryError> {
        match tokio::fs::remove_file(path).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(BoundaryError::new(error.to_string())),
        }
    }

    async fn metadata(&self, path: &Path) -> Result<Option<NativeFileMetadata>, BoundaryError> {
        match tokio::fs::metadata(path).await {
            Ok(metadata) => Ok(Some(NativeFileMetadata {
                length: metadata.len(),
            })),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(BoundaryError::new(error.to_string())),
        }
    }
}
