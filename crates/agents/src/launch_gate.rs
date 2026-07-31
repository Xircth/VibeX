//! Launch-time authorization derived from current on-disk component evidence.

use std::path::PathBuf;

use sha2::{Digest, Sha256};

use crate::SessionLaunchLock;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchComponentEvidence {
    pub component_kind: String,
    pub absolute_path: PathBuf,
    pub expected_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum LaunchGateError {
    #[error("locked component `{component_kind}` does not use an absolute path: {path}")]
    NonAbsolutePath {
        component_kind: String,
        path: PathBuf,
    },
    #[error("locked component `{component_kind}` is missing: {path}")]
    Missing {
        component_kind: String,
        path: PathBuf,
    },
    #[error(
        "locked component `{component_kind}` failed SHA-256 verification: expected {expected}, found {actual}"
    )]
    HashMismatch {
        component_kind: String,
        path: PathBuf,
        expected: String,
        actual: String,
    },
    #[error("locked component `{component_kind}` has no integrity evidence")]
    MissingIntegrity { component_kind: String },
    #[error("failed to read locked component `{component_kind}` at {path}: {message}")]
    Read {
        component_kind: String,
        path: PathBuf,
        message: String,
    },
}

pub struct LaunchGate;

impl LaunchGate {
    pub async fn verify(
        lock: SessionLaunchLock,
        components: &[LaunchComponentEvidence],
    ) -> Result<SessionLaunchLock, LaunchGateError> {
        Self::verify_components(components).await?;
        Ok(lock)
    }

    pub async fn verify_components(
        components: &[LaunchComponentEvidence],
    ) -> Result<(), LaunchGateError> {
        for component in components {
            if !component.absolute_path.is_absolute() {
                return Err(LaunchGateError::NonAbsolutePath {
                    component_kind: component.component_kind.clone(),
                    path: component.absolute_path.clone(),
                });
            }
            if component.expected_sha256.trim().is_empty() {
                return Err(LaunchGateError::MissingIntegrity {
                    component_kind: component.component_kind.clone(),
                });
            }
            let bytes = match tokio::fs::read(&component.absolute_path).await {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Err(LaunchGateError::Missing {
                        component_kind: component.component_kind.clone(),
                        path: component.absolute_path.clone(),
                    });
                }
                Err(error) => {
                    return Err(LaunchGateError::Read {
                        component_kind: component.component_kind.clone(),
                        path: component.absolute_path.clone(),
                        message: error.to_string(),
                    });
                }
            };
            let actual = format!("{:x}", Sha256::digest(bytes));
            let expected = component.expected_sha256.to_ascii_lowercase();
            if actual != expected {
                return Err(LaunchGateError::HashMismatch {
                    component_kind: component.component_kind.clone(),
                    path: component.absolute_path.clone(),
                    expected,
                    actual,
                });
            }
        }
        Ok(())
    }
}
