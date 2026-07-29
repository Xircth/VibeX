use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use serde::{Deserialize, Serialize};

use crate::ToolRuntimeError;

#[derive(Clone, Debug)]
pub struct ToolRuntimeConfig {
    pub managed_root: PathBuf,
}

impl ToolRuntimeConfig {
    pub fn new(managed_root: PathBuf) -> Self {
        Self { managed_root }
    }

    pub(crate) fn validate(&self) -> Result<(), ToolRuntimeError> {
        if !self.managed_root.is_absolute() {
            return Err(ToolRuntimeError::invalid_request(
                "managed tool root must be an absolute path",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolRequest {
    pub tool_id: String,
    pub version: String,
    pub target: String,
    pub url: String,
    pub sha256: String,
    pub executable_name: String,
    pub probe_args: Vec<String>,
}

impl ToolRequest {
    pub(crate) fn validate(&self) -> Result<(), ToolRuntimeError> {
        if self.tool_id.is_empty() || self.version.is_empty() {
            return Err(ToolRuntimeError::invalid_request(
                "tool id and version must not be empty",
            ));
        }
        let executable = std::path::Path::new(&self.executable_name);
        if self.executable_name.is_empty()
            || executable.is_absolute()
            || executable.components().count() != 1
        {
            return Err(ToolRuntimeError::invalid_request(
                "executable name must be a single relative path component",
            ));
        }
        if self.sha256.len() != 64 || !self.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(ToolRuntimeError::invalid_request(
                "sha256 must contain exactly 64 hexadecimal characters",
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ToolInstallationLock {
    pub schema_version: u32,
    pub tool_id: String,
    pub version: String,
    pub target: String,
    pub source_url: String,
    pub sha256: String,
    pub executable_path: PathBuf,
    pub installed_at_unix_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstallationAttempt {
    pub id: uuid::Uuid,
    pub tool_id: String,
    pub version: String,
    pub staging_dir: PathBuf,
    pub started_at_unix_ms: u64,
}

#[derive(Debug, Eq, PartialEq)]
pub struct ToolLease {
    pub tool_id: String,
    pub version: String,
    pub executable_path: PathBuf,
    pub(crate) lease_id: uuid::Uuid,
}

#[derive(Clone, Debug, Default)]
pub struct CancellationToken {
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}
