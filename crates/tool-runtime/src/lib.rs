//! Managed, verified runtime for declarative tool dependencies.

mod adapters;
mod error;
mod install;
mod ports;
mod types;

pub use adapters::{
    CommandProcessProbe, FileInstallationLockStore, HttpDownloader, LocalToolFilesystem,
};
pub use error::{PortError, ToolRuntimeError};
pub use install::ToolRuntime;
pub use ports::{
    Downloader, InstallationLockGuard, InstallationLockStore, ProcessProbe, ToolFilesystem,
};
pub use types::{
    CancellationToken, InstallationAttempt, ToolInstallationLock, ToolLease, ToolRequest,
    ToolRuntimeConfig,
};
