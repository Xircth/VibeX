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
        validate_managed_component("tool id", &self.tool_id, false)?;
        validate_managed_component("tool version", &self.version, true)?;
        validate_managed_component("executable name", &self.executable_name, false)?;
        if self.sha256.len() != 64 || !self.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(ToolRuntimeError::invalid_request(
                "sha256 must contain exactly 64 hexadecimal characters",
            ));
        }
        Ok(())
    }
}

pub(crate) fn validate_managed_component(
    label: &str,
    value: &str,
    allow_plus: bool,
) -> Result<(), ToolRuntimeError> {
    let mut bytes = value.bytes();
    let starts_safely = bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphanumeric());
    let rest_is_safe = bytes.all(|byte| {
        byte.is_ascii_alphanumeric()
            || matches!(byte, b'.' | b'_' | b'-')
            || (allow_plus && byte == b'+')
    });
    if !starts_safely || !rest_is_safe {
        return Err(ToolRuntimeError::invalid_request(format!(
            "{label} must be one safe managed-path component"
        )));
    }
    Ok(())
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

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct InstallationAttempt {
    pub id: uuid::Uuid,
    pub tool_id: String,
    pub version: String,
    pub staging_dir: PathBuf,
    pub started_at_unix_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolLease {
    pub tool_id: String,
    pub version: String,
    pub executable_path: PathBuf,
    pub(crate) lease_id: uuid::Uuid,
}

#[derive(Debug, Default)]
struct CancellationState {
    cancelled: AtomicBool,
    notify: tokio::sync::Notify,
}

#[derive(Clone, Debug, Default)]
pub struct CancellationToken {
    state: Arc<CancellationState>,
}

impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        if !self.state.cancelled.swap(true, Ordering::SeqCst) {
            self.state.notify.notify_waiters();
        }
    }

    pub fn is_cancelled(&self) -> bool {
        self.state.cancelled.load(Ordering::SeqCst)
    }

    pub async fn cancelled(&self) {
        loop {
            let notified = self.state.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }
}
