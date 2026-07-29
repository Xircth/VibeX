use std::{
    net::{Ipv4Addr, SocketAddrV4, TcpListener},
    path::{Path, PathBuf},
    time::Duration,
};

use async_trait::async_trait;
use uuid::Uuid;

use crate::{
    ArtifactEvent, ArtifactRecord, OfficeProcessId, PendingPreviewEvent, PendingRevisionEvent,
    PortError, ResolvedToolInstallation, ToolLockEvidence,
};

#[async_trait]
pub trait ArtifactRepository: Send + Sync {
    async fn latest_for_path(
        &self,
        conversation_id: Uuid,
        scope_root: &Path,
        relative_path: &Path,
    ) -> Result<Option<ArtifactRecord>, PortError>;

    /// Atomically persists a revision and its durable event outbox entry.
    async fn commit_revision(
        &self,
        record: &ArtifactRecord,
        event: &ArtifactEvent,
    ) -> Result<(), PortError>;

    async fn pending_revision_event(
        &self,
        _artifact_id: Uuid,
        _revision: u64,
    ) -> Result<Option<ArtifactEvent>, PortError> {
        Ok(None)
    }

    async fn pending_revision_events(
        &self,
        _limit: usize,
    ) -> Result<Vec<PendingRevisionEvent>, PortError> {
        Ok(Vec::new())
    }

    async fn mark_revision_event_delivered(
        &self,
        _artifact_id: Uuid,
        _revision: u64,
    ) -> Result<(), PortError> {
        Ok(())
    }

    /// Persists a preview lifecycle event before projection. Returns `true`
    /// while the event still needs delivery.
    async fn commit_preview_event(
        &self,
        _key: &str,
        _event: &ArtifactEvent,
    ) -> Result<bool, PortError> {
        Ok(true)
    }

    async fn pending_preview_events(
        &self,
        _limit: usize,
    ) -> Result<Vec<PendingPreviewEvent>, PortError> {
        Ok(Vec::new())
    }

    async fn mark_preview_event_delivered(&self, _key: &str) -> Result<(), PortError> {
        Ok(())
    }

    async fn find(&self, artifact_id: Uuid) -> Result<Option<ArtifactRecord>, PortError>;
}

#[async_trait]
pub trait ArtifactEventSink: Send + Sync {
    async fn append(&self, event: &ArtifactEvent) -> Result<(), PortError>;
}

#[async_trait]
pub trait ArtifactFilesystem: Send + Sync {
    async fn canonicalize(&self, path: &Path) -> Result<PathBuf, PortError>;
    async fn read(&self, path: &Path) -> Result<Vec<u8>, PortError>;
}

#[async_trait]
pub trait ToolInstallationResolver: Send + Sync {
    async fn resolve(
        &self,
        evidence: &ToolLockEvidence,
    ) -> Result<Option<ResolvedToolInstallation>, PortError>;

    async fn release(&self, installation: &mut ResolvedToolInstallation) -> Result<(), PortError> {
        installation.lease = None;
        Ok(())
    }
}

pub trait Clock: Send + Sync {
    fn now_unix_ms(&self) -> u64;
}

#[async_trait]
pub trait OfficeProcessRuntime: Send + Sync {
    fn allocate_port(&self) -> Result<u16, PortError> {
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
            .map_err(|error| PortError::new(error.to_string()))?;
        listener
            .local_addr()
            .map(|address| address.port())
            .map_err(|error| PortError::new(error.to_string()))
    }

    async fn resolve_artifact_path(
        &self,
        scope_root: &Path,
        relative_path: &Path,
    ) -> Result<PathBuf, PortError> {
        Ok(scope_root.join(relative_path))
    }

    async fn spawn(
        &self,
        executable: &Path,
        file: &Path,
        requested_port: u16,
    ) -> Result<OfficeProcessId, PortError>;

    async fn wait_ready_announcement(
        &self,
        process: OfficeProcessId,
        timeout: Duration,
    ) -> Result<u16, PortError>;

    async fn is_running(&self, process: OfficeProcessId) -> Result<bool, PortError>;

    async fn terminate(&self, process: OfficeProcessId) -> Result<(), PortError>;
}

#[async_trait]
pub trait TcpReadyProbe: Send + Sync {
    async fn wait_until_ready(&self, port: u16, timeout: Duration) -> Result<(), PortError>;
}
