use serde::Serialize;

use crate::db::error::DbError;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AppErrorCode {
    InvalidInput,
    ConfigurationMissing,
    ConfigurationInvalid,
    NotFound,
    AlreadyExists,
    PermissionDenied,
    DependencyMissing,
    NetworkError,
    AuthenticationFailed,
    DatabaseError,
    IoError,
    ExternalCommandFailed,
    WindowOperationFailed,
    TaskExecutionFailed,
}

#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct AppCommandError {
    pub code: AppErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl AppCommandError {
    pub fn new(code: AppErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            detail: None,
        }
    }

    pub fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    pub fn db(err: DbError) -> Self {
        Self::new(AppErrorCode::DatabaseError, "Database operation failed")
            .with_detail(err.to_string())
    }

    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new(AppErrorCode::InvalidInput, message)
    }

    pub fn configuration_missing(message: impl Into<String>) -> Self {
        Self::new(AppErrorCode::ConfigurationMissing, message)
    }

    pub fn configuration_invalid(message: impl Into<String>) -> Self {
        Self::new(AppErrorCode::ConfigurationInvalid, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(AppErrorCode::NotFound, message)
    }

    pub fn already_exists(message: impl Into<String>) -> Self {
        Self::new(AppErrorCode::AlreadyExists, message)
    }

    pub fn permission_denied(message: impl Into<String>) -> Self {
        Self::new(AppErrorCode::PermissionDenied, message)
    }

    pub fn dependency_missing(message: impl Into<String>) -> Self {
        Self::new(AppErrorCode::DependencyMissing, message)
    }

    pub fn network(message: impl Into<String>) -> Self {
        Self::new(AppErrorCode::NetworkError, message)
    }

    pub fn authentication_failed(message: impl Into<String>) -> Self {
        Self::new(AppErrorCode::AuthenticationFailed, message)
    }

    pub fn database_error(message: impl Into<String>) -> Self {
        Self::new(AppErrorCode::DatabaseError, message)
    }

    pub fn io_error(message: impl Into<String>) -> Self {
        Self::new(AppErrorCode::IoError, message)
    }

    pub fn task_execution_failed(message: impl Into<String>) -> Self {
        Self::new(AppErrorCode::TaskExecutionFailed, message)
    }

    pub fn io(err: std::io::Error) -> Self {
        let code = match err.kind() {
            std::io::ErrorKind::NotFound => AppErrorCode::NotFound,
            std::io::ErrorKind::PermissionDenied => AppErrorCode::PermissionDenied,
            std::io::ErrorKind::AlreadyExists => AppErrorCode::AlreadyExists,
            _ => AppErrorCode::IoError,
        };

        let message = match code {
            AppErrorCode::NotFound => "Resource not found",
            AppErrorCode::PermissionDenied => "Permission denied",
            AppErrorCode::AlreadyExists => "Resource already exists",
            _ => "I/O operation failed",
        };

        Self::new(code, message).with_detail(err.to_string())
    }

    pub fn window(message: impl Into<String>, detail: impl Into<String>) -> Self {
        Self::new(AppErrorCode::WindowOperationFailed, message).with_detail(detail)
    }

    pub fn external_command(message: impl Into<String>, detail: impl Into<String>) -> Self {
        Self::new(AppErrorCode::ExternalCommandFailed, message).with_detail(detail)
    }
}

impl From<DbError> for AppCommandError {
    fn from(value: DbError) -> Self {
        Self::db(value)
    }
}
