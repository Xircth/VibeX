use std::{
    collections::HashMap,
    path::{Component, Path},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    ArtifactEvent, ArtifactEventSink, ArtifactFilesystem, ArtifactPreviewReference, ArtifactRecord,
    ArtifactRepository, ArtifactServiceError, OpenPreview, PreviewLease, PreviewProviderRegistry,
    PreviewReapReason, ProviderPreviewRequest, ProviderReapReport, RecordArtifact,
    ResolvedToolInstallation, ToolInstallationResolver,
};

type ArtifactLocation = (Uuid, std::path::PathBuf, std::path::PathBuf);
type RecordLocks = HashMap<ArtifactLocation, Arc<tokio::sync::Mutex<()>>>;

#[derive(Clone)]
pub struct ArtifactService {
    repository: Arc<dyn ArtifactRepository>,
    events: Arc<dyn ArtifactEventSink>,
    filesystem: Arc<dyn ArtifactFilesystem>,
    previews: Option<PreviewDependencies>,
    preview_leases: Arc<tokio::sync::Mutex<HashMap<Uuid, PreviewLeaseOwner>>>,
    record_locks: Arc<tokio::sync::Mutex<RecordLocks>>,
}

#[derive(Clone)]
struct PreviewDependencies {
    registry: PreviewProviderRegistry,
    tools: Arc<dyn ToolInstallationResolver>,
}

#[derive(Clone)]
struct PreviewLeaseOwner {
    conversation_id: Uuid,
    turn_id: Uuid,
    artifact_id: Uuid,
    provider_id: String,
    installation: Arc<tokio::sync::Mutex<Option<ResolvedToolInstallation>>>,
    pending_terminal: Arc<tokio::sync::Mutex<Option<ArtifactEvent>>>,
}

impl ArtifactService {
    pub fn new(
        repository: Arc<dyn ArtifactRepository>,
        events: Arc<dyn ArtifactEventSink>,
        filesystem: Arc<dyn ArtifactFilesystem>,
    ) -> Self {
        Self {
            repository,
            events,
            filesystem,
            previews: None,
            preview_leases: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            record_locks: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        }
    }

    pub fn with_previews(
        mut self,
        registry: PreviewProviderRegistry,
        tools: Arc<dyn ToolInstallationResolver>,
    ) -> Self {
        self.previews = Some(PreviewDependencies { registry, tools });
        self
    }

    pub async fn record(
        &self,
        request: RecordArtifact,
    ) -> Result<ArtifactRecord, ArtifactServiceError> {
        self.flush_pending_revision_events(100).await?;
        validate_relative_path(&request.relative_path)?;
        if !request.scope_root.is_absolute() {
            return Err(ArtifactServiceError::PathOutsideScope(
                "scope root must be absolute".into(),
            ));
        }
        let canonical_root = self.filesystem.canonicalize(&request.scope_root).await?;
        let candidate = canonical_root.join(&request.relative_path);
        let canonical_path = self.filesystem.canonicalize(&candidate).await?;
        if !canonical_path.starts_with(&canonical_root) || canonical_path == canonical_root {
            return Err(ArtifactServiceError::PathOutsideScope(
                request.relative_path.display().to_string(),
            ));
        }

        let bytes = self.filesystem.read(&canonical_path).await?;
        let content_hash = format!("{:x}", Sha256::digest(bytes));
        let record_lock = {
            let mut locks = self.record_locks.lock().await;
            locks
                .entry((
                    request.conversation_id,
                    canonical_root.clone(),
                    request.relative_path.clone(),
                ))
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                .clone()
        };
        let _record_guard = record_lock.lock().await;
        let latest = self
            .repository
            .latest_for_path(
                request.conversation_id,
                &canonical_root,
                &request.relative_path,
            )
            .await?;
        if let Some(latest) = latest.as_ref()
            && latest.content_hash == content_hash
        {
            self.deliver_pending_revision_event(latest).await?;
            return Ok(latest.clone());
        }

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let record = ArtifactRecord {
            id: latest
                .as_ref()
                .map_or_else(Uuid::new_v4, |record| record.id),
            conversation_id: request.conversation_id,
            turn_id: request.turn_id,
            workspace_id: request.workspace_id,
            scope_root: canonical_root,
            relative_path: request.relative_path,
            media_type: request.media_type,
            content_hash,
            revision: latest.as_ref().map_or(1, |record| record.revision + 1),
            producer: request.producer,
            created_at_unix_ms: latest
                .as_ref()
                .map_or(now, |record| record.created_at_unix_ms),
            updated_at_unix_ms: now,
        };
        let event = ArtifactEvent::RevisionRecorded {
            artifact: Box::new((&record).into()),
        };
        self.repository.commit_revision(&record, &event).await?;
        self.events.append(&event).await?;
        self.repository
            .mark_revision_event_delivered(record.id, record.revision)
            .await?;
        Ok(record)
    }

    async fn deliver_pending_revision_event(
        &self,
        record: &ArtifactRecord,
    ) -> Result<(), ArtifactServiceError> {
        let Some(event) = self
            .repository
            .pending_revision_event(record.id, record.revision)
            .await?
        else {
            return Ok(());
        };
        self.events.append(&event).await?;
        self.repository
            .mark_revision_event_delivered(record.id, record.revision)
            .await?;
        Ok(())
    }

    pub async fn flush_pending_revision_events(
        &self,
        limit: usize,
    ) -> Result<usize, ArtifactServiceError> {
        let pending = self.repository.pending_revision_events(limit).await?;
        let count = pending.len();
        for pending in pending {
            self.events.append(&pending.event).await?;
            self.repository
                .mark_revision_event_delivered(pending.artifact_id, pending.revision)
                .await?;
        }
        Ok(count)
    }

    async fn deliver_preview_event(
        &self,
        event: &ArtifactEvent,
    ) -> Result<(), ArtifactServiceError> {
        let key = preview_event_key(event)
            .ok_or_else(|| ArtifactServiceError::Preview("not a preview lifecycle event".into()))?;
        if self.repository.commit_preview_event(&key, event).await? {
            self.events.append(event).await?;
            self.repository.mark_preview_event_delivered(&key).await?;
        }
        Ok(())
    }

    pub async fn open_preview(
        &self,
        request: OpenPreview,
    ) -> Result<PreviewLease, ArtifactServiceError> {
        let operation_id = Uuid::new_v4();
        let dependencies = self
            .previews
            .as_ref()
            .ok_or_else(|| ArtifactServiceError::ProviderNotFound("preview registry".into()))?;
        let artifact = self
            .repository
            .find(request.artifact_id)
            .await?
            .ok_or(ArtifactServiceError::ArtifactNotFound(request.artifact_id))?;
        let canonical_root = self.filesystem.canonicalize(&artifact.scope_root).await?;
        let canonical_path = self
            .filesystem
            .canonicalize(&canonical_root.join(&artifact.relative_path))
            .await?;
        if canonical_path == canonical_root || !canonical_path.starts_with(&canonical_root) {
            return Err(ArtifactServiceError::PathOutsideScope(
                artifact.relative_path.display().to_string(),
            ));
        }
        let mut artifact = artifact;
        artifact.scope_root = canonical_root;
        artifact.relative_path = canonical_path
            .strip_prefix(&artifact.scope_root)
            .map_err(|error| ArtifactServiceError::PathOutsideScope(error.to_string()))?
            .to_path_buf();
        let provider_id = artifact.producer.provider_id.clone();
        let provider = dependencies
            .registry
            .get(&provider_id)
            .ok_or_else(|| ArtifactServiceError::ProviderNotFound(provider_id.clone()))?;
        let mut installation = dependencies
            .tools
            .resolve(&artifact.producer.tool_lock)
            .await?
            .ok_or_else(|| {
                ArtifactServiceError::ToolUnresolved(artifact.producer.tool_lock.id.clone())
            })?;
        let evidence = &artifact.producer.tool_lock;
        if installation.lock.tool_id != evidence.tool_id
            || installation.lock.version != evidence.version
            || installation.lock.target != evidence.target
            || installation.lock.sha256 != evidence.sha256
            || installation.lock.executable_path != evidence.executable_path
            || !installation.lock.executable_path.is_absolute()
        {
            let _ = dependencies.tools.release(&mut installation).await;
            return Err(ArtifactServiceError::ToolUnresolved(evidence.id.clone()));
        }
        let probe = match provider.probe(&installation.lock).await {
            Ok(probe) => probe,
            Err(error) => {
                let _ = dependencies.tools.release(&mut installation).await;
                return Err(error);
            }
        };
        if !probe.ready {
            let _ = dependencies.tools.release(&mut installation).await;
            return Err(ArtifactServiceError::Preview(probe.message.unwrap_or_else(
                || format!("provider `{provider_id}` is not ready"),
            )));
        }
        let conversation_id = artifact.conversation_id;
        let turn_id = artifact.turn_id;
        let result = provider
            .open_preview(ProviderPreviewRequest {
                artifact,
                tool: installation.lock.clone(),
            })
            .await;
        match result {
            Ok(lease) => {
                let installation = Arc::new(tokio::sync::Mutex::new(Some(installation)));
                let preview = ArtifactPreviewReference {
                    conversation_id,
                    turn_id,
                    artifact_id: lease.artifact_id,
                    provider_id: lease.provider_id.clone(),
                    lease_id: lease.id,
                };
                self.preview_leases.lock().await.insert(
                    lease.id,
                    PreviewLeaseOwner {
                        conversation_id,
                        turn_id,
                        artifact_id: lease.artifact_id,
                        provider_id: lease.provider_id.clone(),
                        installation: installation.clone(),
                        pending_terminal: Arc::new(tokio::sync::Mutex::new(None)),
                    },
                );
                if let Err(error) = self
                    .deliver_preview_event(&ArtifactEvent::PreviewOpened { preview })
                    .await
                {
                    provider.close_preview(lease.id).await?;
                    let closed = ArtifactEvent::PreviewClosed {
                        preview: ArtifactPreviewReference {
                            conversation_id,
                            turn_id,
                            artifact_id: lease.artifact_id,
                            provider_id: lease.provider_id.clone(),
                            lease_id: lease.id,
                        },
                    };
                    let closed_key = preview_event_key(&closed).expect("closed event has a key");
                    self.repository
                        .commit_preview_event(&closed_key, &closed)
                        .await?;
                    let mut installation = installation.lock().await;
                    if let Some(installation) = installation.as_mut() {
                        dependencies.tools.release(installation).await?;
                    }
                    self.preview_leases.lock().await.remove(&lease.id);
                    return Err(error);
                }
                Ok(lease)
            }
            Err(error) => {
                let _ = dependencies.tools.release(&mut installation).await;
                self.deliver_preview_event(&ArtifactEvent::PreviewFailed {
                    operation_id,
                    conversation_id,
                    turn_id,
                    artifact_id: request.artifact_id,
                    provider_id,
                    message: error.to_string(),
                })
                .await?;
                Err(error)
            }
        }
    }

    pub async fn close_preview(&self, lease_id: Uuid) -> Result<(), ArtifactServiceError> {
        let dependencies = self
            .previews
            .as_ref()
            .ok_or(ArtifactServiceError::PreviewLeaseNotFound(lease_id))?;
        let owner = self
            .preview_leases
            .lock()
            .await
            .get(&lease_id)
            .cloned()
            .ok_or(ArtifactServiceError::PreviewLeaseNotFound(lease_id))?;
        let provider = dependencies
            .registry
            .get(&owner.provider_id)
            .ok_or_else(|| ArtifactServiceError::ProviderNotFound(owner.provider_id.clone()))?;
        if owner.pending_terminal.lock().await.is_some() {
            return self
                .finalize_pending_preview(lease_id, owner, dependencies)
                .await;
        }
        provider.close_preview(lease_id).await?;
        *owner.pending_terminal.lock().await = Some(ArtifactEvent::PreviewClosed {
            preview: ArtifactPreviewReference {
                conversation_id: owner.conversation_id,
                turn_id: owner.turn_id,
                artifact_id: owner.artifact_id,
                provider_id: owner.provider_id.clone(),
                lease_id,
            },
        });
        self.finalize_pending_preview(lease_id, owner, dependencies)
            .await
    }

    pub async fn reap_previews(&self) -> Result<usize, ArtifactServiceError> {
        let Some(dependencies) = self.previews.as_ref() else {
            return Ok(0);
        };
        self.flush_pending_preview_events().await?;
        let mut reaped = 0;
        for provider in dependencies.registry.providers() {
            let report = provider.reap_idle().await?;
            reaped += report.processes_reaped;
            self.apply_reap_report(&provider.descriptor().id, report)
                .await?;
        }
        Ok(reaped)
    }

    pub async fn apply_reap_report(
        &self,
        provider_id: &str,
        report: ProviderReapReport,
    ) -> Result<usize, ArtifactServiceError> {
        let Some(dependencies) = self.previews.as_ref() else {
            return Ok(0);
        };
        let mut pending = Vec::new();
        for lease in report.leases {
            let owner = self
                .preview_leases
                .lock()
                .await
                .get(&lease.lease_id)
                .cloned();
            let Some(owner) = owner.filter(|owner| owner.provider_id == provider_id) else {
                continue;
            };
            let event = match lease.reason {
                PreviewReapReason::Expired => ArtifactEvent::PreviewClosed {
                    preview: ArtifactPreviewReference {
                        conversation_id: owner.conversation_id,
                        turn_id: owner.turn_id,
                        artifact_id: owner.artifact_id,
                        provider_id: owner.provider_id.clone(),
                        lease_id: lease.lease_id,
                    },
                },
                PreviewReapReason::Crashed => ArtifactEvent::PreviewFailed {
                    operation_id: Uuid::new_v4(),
                    conversation_id: owner.conversation_id,
                    turn_id: owner.turn_id,
                    artifact_id: owner.artifact_id,
                    provider_id: owner.provider_id.clone(),
                    message: "preview provider process exited unexpectedly".into(),
                },
            };
            *owner.pending_terminal.lock().await = Some(event);
            pending.push((lease.lease_id, owner));
        }
        let mut first_error = self.flush_pending_preview_events().await.err();
        let mut finalized = 0;
        for (lease_id, owner) in pending {
            if !self.preview_leases.lock().await.contains_key(&lease_id) {
                finalized += 1;
                continue;
            }
            match self
                .finalize_pending_preview(lease_id, owner, dependencies)
                .await
            {
                Ok(()) => finalized += 1,
                Err(error) if first_error.is_none() => first_error = Some(error),
                Err(_) => {}
            }
        }
        if let Some(error) = first_error {
            return Err(error);
        }
        Ok(finalized)
    }

    pub async fn flush_pending_preview_events(&self) -> Result<usize, ArtifactServiceError> {
        let Some(dependencies) = self.previews.as_ref() else {
            return Ok(0);
        };
        let durable = self.repository.pending_preview_events(100).await?;
        let mut count = 0;
        let mut first_error = None;
        for pending in durable {
            match self.events.append(&pending.event).await {
                Ok(()) => {
                    match self
                        .repository
                        .mark_preview_event_delivered(&pending.key)
                        .await
                    {
                        Ok(()) => count += 1,
                        Err(error) if first_error.is_none() => {
                            first_error = Some(ArtifactServiceError::from(error));
                        }
                        Err(_) => {}
                    }
                }
                Err(error) if first_error.is_none() => {
                    first_error = Some(ArtifactServiceError::from(error));
                }
                Err(_) => {}
            }
        }
        let pending = self
            .preview_leases
            .lock()
            .await
            .iter()
            .filter_map(|(lease_id, owner)| {
                owner
                    .pending_terminal
                    .try_lock()
                    .ok()
                    .and_then(|event| event.is_some().then_some((*lease_id, owner.clone())))
            })
            .collect::<Vec<_>>();
        for (lease_id, owner) in pending {
            match self
                .finalize_pending_preview(lease_id, owner, dependencies)
                .await
            {
                Ok(()) => count += 1,
                Err(error) if first_error.is_none() => first_error = Some(error),
                Err(_) => {}
            }
        }
        if let Some(error) = first_error {
            return Err(error);
        }
        Ok(count)
    }

    async fn finalize_pending_preview(
        &self,
        lease_id: Uuid,
        owner: PreviewLeaseOwner,
        dependencies: &PreviewDependencies,
    ) -> Result<(), ArtifactServiceError> {
        let event = owner
            .pending_terminal
            .lock()
            .await
            .clone()
            .ok_or(ArtifactServiceError::PreviewLeaseNotFound(lease_id))?;
        self.deliver_preview_event(&event).await?;
        let mut installation = owner.installation.lock().await;
        if let Some(installation) = installation.as_mut() {
            dependencies.tools.release(installation).await?;
        }
        *installation = None;
        self.preview_leases.lock().await.remove(&lease_id);
        Ok(())
    }

    pub async fn shutdown_previews(&self) -> Result<usize, ArtifactServiceError> {
        let lease_ids = self
            .preview_leases
            .lock()
            .await
            .keys()
            .copied()
            .collect::<Vec<_>>();
        let mut closed = 0;
        for lease_id in lease_ids {
            match self.close_preview(lease_id).await {
                Ok(()) => closed += 1,
                Err(ArtifactServiceError::PreviewLeaseNotFound(_)) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(closed)
    }
}

fn validate_relative_path(path: &Path) -> Result<(), ArtifactServiceError> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(ArtifactServiceError::PathOutsideScope(
            path.display().to_string(),
        ));
    }
    Ok(())
}

fn preview_event_key(event: &ArtifactEvent) -> Option<String> {
    match event {
        ArtifactEvent::PreviewOpened { preview } => {
            Some(format!("preview:{}:opened", preview.lease_id))
        }
        ArtifactEvent::PreviewClosed { preview } => {
            Some(format!("preview:{}:closed", preview.lease_id))
        }
        ArtifactEvent::PreviewFailed { operation_id, .. } => {
            Some(format!("preview-operation:{operation_id}:failed"))
        }
        ArtifactEvent::RevisionRecorded { .. } => None,
    }
}
