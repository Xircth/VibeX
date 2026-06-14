use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Not found: {0}")]
    NotFound(String),
    #[error("Bad request: {0}")]
    BadRequest(String),
    #[error("Internal error: {0}")]
    Internal(String),
    #[error("Conflict: {0}")]
    Conflict(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}

impl From<sqlx::Error> for AppError {
    fn from(e: sqlx::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}

impl From<db::models::repo::RepoError> for AppError {
    fn from(e: db::models::repo::RepoError) -> Self {
        match e {
            db::models::repo::RepoError::NotFound => {
                AppError::NotFound("Repository not found".to_string())
            }
            db::models::repo::RepoError::Database(e) => AppError::Internal(e.to_string()),
        }
    }
}

impl From<db::models::workspace::WorkspaceError> for AppError {
    fn from(e: db::models::workspace::WorkspaceError) -> Self {
        AppError::Internal(e.to_string())
    }
}

impl From<git::GitServiceError> for AppError {
    fn from(e: git::GitServiceError) -> Self {
        match e {
            git::GitServiceError::MergeConflicts { message, .. } => {
                AppError::Conflict(format!("Merge conflicts: {}", message))
            }
            git::GitServiceError::RebaseInProgress => {
                AppError::Conflict("Rebase already in progress".to_string())
            }
            git::GitServiceError::BranchNotFound(branch) => {
                AppError::NotFound(format!("Branch not found: {}", branch))
            }
            other => AppError::Internal(other.to_string()),
        }
    }
}

impl From<services::services::git_host::GitHostError> for AppError {
    fn from(e: services::services::git_host::GitHostError) -> Self {
        AppError::Internal(e.to_string())
    }
}

impl From<services::services::container::ContainerError> for AppError {
    fn from(e: services::services::container::ContainerError) -> Self {
        AppError::Internal(e.to_string())
    }
}

impl From<db::models::session::SessionError> for AppError {
    fn from(e: db::models::session::SessionError) -> Self {
        AppError::Internal(e.to_string())
    }
}

impl From<db::models::execution_process::ExecutionProcessError> for AppError {
    fn from(e: db::models::execution_process::ExecutionProcessError) -> Self {
        AppError::Internal(e.to_string())
    }
}

impl From<db::models::scratch::ScratchError> for AppError {
    fn from(e: db::models::scratch::ScratchError) -> Self {
        match e {
            db::models::scratch::ScratchError::TypeMismatch { expected, actual } => {
                AppError::BadRequest(format!(
                    "Scratch type mismatch: expected {}, got {}",
                    expected, actual
                ))
            }
            other => AppError::Internal(other.to_string()),
        }
    }
}

impl From<executors::executors::ExecutorError> for AppError {
    fn from(e: executors::executors::ExecutorError) -> Self {
        AppError::Internal(e.to_string())
    }
}

impl From<services::services::config::ConfigError> for AppError {
    fn from(e: services::services::config::ConfigError) -> Self {
        AppError::Internal(e.to_string())
    }
}

impl From<services::services::repo::RepoError> for AppError {
    fn from(e: services::services::repo::RepoError) -> Self {
        AppError::Internal(e.to_string())
    }
}

impl From<git2::Error> for AppError {
    fn from(e: git2::Error) -> Self {
        AppError::Internal(e.to_string())
    }
}
