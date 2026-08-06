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
use tokio::io::AsyncWriteExt;

static NATIVE_CONFIG_TRANSACTION_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeFileMutation {
    pub path: PathBuf,
    pub expected: Option<Vec<u8>>,
    pub replacement: Option<Vec<u8>>,
    pub sensitive: bool,
}

#[async_trait]
pub trait NativeFileSystem: Send + Sync {
    async fn read(&self, path: &Path) -> Result<Option<Vec<u8>>, BoundaryError>;
    async fn write_atomic(
        &self,
        path: &Path,
        bytes: &[u8],
        sensitive: bool,
    ) -> Result<(), BoundaryError>;
    async fn remove_file(&self, path: &Path) -> Result<(), BoundaryError> {
        Err(BoundaryError::new(format!(
            "filesystem adapter cannot remove `{}`",
            path.display()
        )))
    }
    async fn apply_many_atomic(
        &self,
        mutations: &[NativeFileMutation],
    ) -> Result<(), BoundaryError> {
        let _transaction = NATIVE_CONFIG_TRANSACTION_LOCK.lock().await;
        for mutation in mutations {
            let current = self.read(&mutation.path).await?;
            if current != mutation.expected {
                return Err(BoundaryError::new(format!(
                    "native file changed on disk: `{}`",
                    mutation.path.display()
                )));
            }
        }

        for (committed, mutation) in mutations.iter().enumerate() {
            let current = self.read(&mutation.path).await?;
            if current != mutation.expected {
                let error = BoundaryError::new(format!(
                    "native file changed during transaction: `{}`",
                    mutation.path.display()
                ));
                let rollback = &mutations[..committed];
                for previous in rollback.iter().rev() {
                    match &previous.expected {
                        Some(bytes) => {
                            self.write_atomic(&previous.path, bytes, previous.sensitive)
                                .await?;
                        }
                        None => self.remove_file(&previous.path).await?,
                    }
                }
                return Err(error);
            }
            let result = match &mutation.replacement {
                Some(bytes) => {
                    self.write_atomic(&mutation.path, bytes, mutation.sensitive)
                        .await
                }
                None => self.remove_file(&mutation.path).await,
            };
            if let Err(error) = result {
                let mut rollback_errors = Vec::new();
                for rollback in mutations[..committed].iter().rev() {
                    let rollback_result = match &rollback.expected {
                        Some(bytes) => {
                            self.write_atomic(&rollback.path, bytes, rollback.sensitive)
                                .await
                        }
                        None => self.remove_file(&rollback.path).await,
                    };
                    if let Err(rollback_error) = rollback_result {
                        rollback_errors.push(rollback_error.to_string());
                    }
                }
                if rollback_errors.is_empty() {
                    return Err(error);
                }
                return Err(BoundaryError::new(format!(
                    "{error}; rollback failed: {}",
                    rollback_errors.join("; ")
                )));
            }
        }
        Ok(())
    }
    async fn write_many_atomic(
        &self,
        writes: &[(PathBuf, Vec<u8>, bool)],
    ) -> Result<(), BoundaryError> {
        let mut mutations = Vec::with_capacity(writes.len());
        for (path, bytes, sensitive) in writes {
            mutations.push(NativeFileMutation {
                path: path.clone(),
                expected: self.read(path).await?,
                replacement: Some(bytes.clone()),
                sensitive: *sensitive,
            });
        }
        self.apply_many_atomic(&mutations).await
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

    async fn write_atomic(
        &self,
        path: &Path,
        bytes: &[u8],
        sensitive: bool,
    ) -> Result<(), BoundaryError> {
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
        let mut options = tokio::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            options.mode(if sensitive { 0o600 } else { 0o666 });
        }
        #[cfg(not(unix))]
        let _ = sensitive;
        let mut file = options
            .open(&temporary)
            .await
            .map_err(|error| BoundaryError::new(error.to_string()))?;
        if let Err(error) = file.write_all(bytes).await {
            drop(file);
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(BoundaryError::new(error.to_string()));
        }
        if let Err(error) = file.sync_all().await {
            drop(file);
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(BoundaryError::new(error.to_string()));
        }
        drop(file);
        #[cfg(not(windows))]
        let replace_result = tokio::fs::rename(&temporary, path).await;
        #[cfg(windows)]
        let replace_result = replace_file_windows(&temporary, path);
        if let Err(error) = replace_result {
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

#[cfg(windows)]
fn replace_file_windows(temporary: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Storage::FileSystem::{
        MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
    };

    let temporary = temporary
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    if unsafe {
        MoveFileExW(
            temporary.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    } == 0
    {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}
