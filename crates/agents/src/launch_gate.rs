//! Launch-time authorization derived from current on-disk component evidence.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::SessionLaunchLock;

/// Whether the persisted launch program currently exists on disk. Follows
/// symlinks, so a broken link (the file a shim points at was deleted or
/// relocated by the Agent's own updater) is reported missing instead of
/// reaching `Command::spawn` as a raw ENOENT.
pub fn launch_program_available(program: &Path) -> bool {
    program.is_absolute() && program.is_file()
}

/// Actionable failure for a session whose launch program is gone. The
/// management lifecycle ("ready") is a probe observation that can go stale, so
/// the session must surface a repair request, not a cryptic spawn error.
pub fn missing_launch_program_error(program: &Path) -> String {
    format!(
        "ACP agent executable is missing at {}; repair or reinstall this Agent in Settings → Agent",
        program.display()
    )
}

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

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::{launch_program_available, missing_launch_program_error};

    #[test]
    fn launch_program_is_unavailable_when_the_binary_is_gone() {
        let missing = PathBuf::from("/definitely/not/here/vibex-acp");
        assert!(!launch_program_available(&missing));
        assert!(!launch_program_available(&PathBuf::from("relative-acp")));
    }

    #[test]
    fn launch_program_is_available_for_a_real_file_but_not_a_directory() {
        let real = std::env::current_exe().expect("test binary path");
        assert!(launch_program_available(&real));
        assert!(!launch_program_available(
            real.parent().expect("dir of test binary")
        ));
    }

    #[cfg(unix)]
    #[test]
    fn launch_program_follows_a_broken_symlink_as_missing() {
        let dir = tempfile::tempdir().unwrap();
        let link = dir.path().join("acp");
        std::os::unix::fs::symlink(dir.path().join("gone"), &link).unwrap();
        assert!(!launch_program_available(&link));
    }

    #[test]
    fn missing_program_error_names_the_path_and_the_remedy() {
        let message = missing_launch_program_error(&PathBuf::from("/stale/vibex-acp"));
        assert!(message.contains("/stale/vibex-acp"), "{message}");
        assert!(message.contains("reinstall"), "{message}");
    }
}
