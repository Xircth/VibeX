//! Artifact records and tool-backed preview providers.

mod adapters;
mod error;
mod ports;
mod preview;
mod service;
mod types;

pub use adapters::{
    CurrentToolInstallationResolver, LocalArtifactFilesystem, SqliteArtifactRepository, SystemClock,
};
pub use error::{ArtifactServiceError, PortError};
pub use ports::{
    ArtifactEventSink, ArtifactFilesystem, ArtifactRepository, Clock, ToolInstallationResolver,
};
pub use preview::{
    ArtifactProviderDescriptor, ArtifactProviderProbe, ArtifactToolProvider,
    PreviewProviderRegistry, PreviewReapReason, ProviderPreviewRequest, ProviderReapReport,
    ReapedPreviewLease,
};
pub use service::ArtifactService;
pub use types::{
    ArtifactEvent, ArtifactPreviewReference, ArtifactRecord, ArtifactReference, OpenPreview,
    PendingPreviewEvent, PendingRevisionEvent, PreviewLease, ProducerEvidence, RecordArtifact,
    ResolvedToolInstallation, ToolLockEvidence,
};
