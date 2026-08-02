use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use artifacts::{
    ArtifactEvent, ArtifactEventSink, ArtifactFilesystem, ArtifactRecord, ArtifactRepository,
    ArtifactService, ArtifactServiceError, PendingRevisionEvent, PortError, ProducerEvidence,
    RecordArtifact, ToolLockEvidence,
};
use async_trait::async_trait;
use uuid::Uuid;

#[derive(Default)]
struct MemoryRepository(Mutex<Vec<ArtifactRecord>>);

#[async_trait]
impl ArtifactRepository for MemoryRepository {
    async fn latest_for_path(
        &self,
        conversation_id: Uuid,
        scope_root: &Path,
        relative_path: &Path,
    ) -> Result<Option<ArtifactRecord>, PortError> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|record| {
                record.conversation_id == conversation_id
                    && record.scope_root == scope_root
                    && record.relative_path == relative_path
            })
            .max_by_key(|record| record.revision)
            .cloned())
    }

    async fn commit_revision(
        &self,
        record: &ArtifactRecord,
        _event: &ArtifactEvent,
    ) -> Result<(), PortError> {
        self.0.lock().unwrap().push(record.clone());
        Ok(())
    }

    async fn find(&self, artifact_id: Uuid) -> Result<Option<ArtifactRecord>, PortError> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .iter()
            .find(|record| record.id == artifact_id)
            .cloned())
    }
}

#[derive(Default)]
struct OutboxRepository {
    records: Mutex<Vec<ArtifactRecord>>,
    pending: Mutex<HashMap<(Uuid, u64), ArtifactEvent>>,
}

#[async_trait]
impl ArtifactRepository for OutboxRepository {
    async fn latest_for_path(
        &self,
        conversation_id: Uuid,
        scope_root: &Path,
        relative_path: &Path,
    ) -> Result<Option<ArtifactRecord>, PortError> {
        Ok(self
            .records
            .lock()
            .unwrap()
            .iter()
            .filter(|record| {
                record.conversation_id == conversation_id
                    && record.scope_root == scope_root
                    && record.relative_path == relative_path
            })
            .max_by_key(|record| record.revision)
            .cloned())
    }

    async fn commit_revision(
        &self,
        record: &ArtifactRecord,
        event: &ArtifactEvent,
    ) -> Result<(), PortError> {
        self.records.lock().unwrap().push(record.clone());
        self.pending
            .lock()
            .unwrap()
            .insert((record.id, record.revision), event.clone());
        Ok(())
    }

    async fn pending_revision_event(
        &self,
        artifact_id: Uuid,
        revision: u64,
    ) -> Result<Option<ArtifactEvent>, PortError> {
        Ok(self
            .pending
            .lock()
            .unwrap()
            .get(&(artifact_id, revision))
            .cloned())
    }

    async fn pending_revision_events(
        &self,
        limit: usize,
    ) -> Result<Vec<PendingRevisionEvent>, PortError> {
        Ok(self
            .pending
            .lock()
            .unwrap()
            .iter()
            .take(limit)
            .map(|((artifact_id, revision), event)| PendingRevisionEvent {
                artifact_id: *artifact_id,
                revision: *revision,
                event: event.clone(),
            })
            .collect())
    }

    async fn mark_revision_event_delivered(
        &self,
        artifact_id: Uuid,
        revision: u64,
    ) -> Result<(), PortError> {
        self.pending
            .lock()
            .unwrap()
            .remove(&(artifact_id, revision));
        Ok(())
    }

    async fn find(&self, artifact_id: Uuid) -> Result<Option<ArtifactRecord>, PortError> {
        Ok(self
            .records
            .lock()
            .unwrap()
            .iter()
            .find(|record| record.id == artifact_id)
            .cloned())
    }
}

#[derive(Default)]
struct FailOnceEvents {
    fail: AtomicBool,
    delivered: Mutex<Vec<ArtifactEvent>>,
}

#[async_trait]
impl ArtifactEventSink for FailOnceEvents {
    async fn append(&self, event: &ArtifactEvent) -> Result<(), PortError> {
        if self.fail.swap(false, Ordering::SeqCst) {
            return Err(PortError::new("injected event failure"));
        }
        self.delivered.lock().unwrap().push(event.clone());
        Ok(())
    }
}

#[derive(Default)]
struct MemoryEvents(Mutex<Vec<ArtifactEvent>>);

#[async_trait]
impl ArtifactEventSink for MemoryEvents {
    async fn append(&self, event: &ArtifactEvent) -> Result<(), PortError> {
        self.0.lock().unwrap().push(event.clone());
        Ok(())
    }
}

struct MemoryFilesystem {
    root: PathBuf,
    bytes: Mutex<Vec<u8>>,
}

#[async_trait]
impl ArtifactFilesystem for MemoryFilesystem {
    async fn canonicalize(&self, path: &Path) -> Result<PathBuf, PortError> {
        Ok(path.to_path_buf())
    }

    async fn read(&self, path: &Path) -> Result<Vec<u8>, PortError> {
        assert!(path.starts_with(&self.root));
        Ok(self.bytes.lock().unwrap().clone())
    }
}

fn request(root: &Path, conversation_id: Uuid, turn_id: Uuid) -> RecordArtifact {
    RecordArtifact {
        conversation_id,
        turn_id,
        workspace_id: Some(Uuid::new_v4()),
        scope_root: root.to_path_buf(),
        relative_path: PathBuf::from("reports/quarter.xlsx"),
        media_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".into(),
        producer: ProducerEvidence {
            plugin_id: "builtin.office".into(),
            plugin_version: "2.0.0".into(),
            provider_id: "officecli".into(),
            tool_lock: ToolLockEvidence {
                id: "officecli-lock-0.8.0".into(),
                tool_id: "officecli".into(),
                version: "0.8.0".into(),
                target: "aarch64-apple-darwin".into(),
                sha256: "a".repeat(64),
                executable_path: root.join(".tools/officecli"),
            },
        },
    }
}

#[tokio::test]
async fn records_only_content_changes() -> Result<(), ArtifactServiceError> {
    let root = PathBuf::from("/workspace");
    let filesystem = Arc::new(MemoryFilesystem {
        root: root.clone(),
        bytes: Mutex::new(b"A".to_vec()),
    });
    let repository = Arc::new(MemoryRepository::default());
    let events = Arc::new(MemoryEvents::default());
    let service = ArtifactService::new(repository.clone(), events.clone(), filesystem.clone());
    let conversation_id = Uuid::new_v4();
    let turn_id = Uuid::new_v4();

    let first = service
        .record(request(&root, conversation_id, turn_id))
        .await?;
    let duplicate = service
        .record(request(&root, conversation_id, turn_id))
        .await?;
    *filesystem.bytes.lock().unwrap() = b"B".to_vec();
    let changed = service
        .record(request(&root, conversation_id, turn_id))
        .await?;

    assert_eq!(first.revision, 1);
    assert_eq!(duplicate.id, first.id);
    assert_eq!(changed.revision, 2);

    let persisted = repository.0.lock().unwrap();
    assert_eq!(persisted.len(), 2);
    assert_eq!(persisted[0].producer, persisted[1].producer);
    assert_eq!(persisted[0].producer.plugin_id, "builtin.office");
    assert_eq!(persisted[0].producer.tool_lock.version, "0.8.0");
    drop(persisted);

    let emitted = events.0.lock().unwrap();
    assert_eq!(emitted.len(), 2);
    assert!(
        emitted
            .iter()
            .all(|event| matches!(event, ArtifactEvent::RevisionRecorded { .. }))
    );
    assert!(
        !serde_json::to_string(&*emitted)
            .unwrap()
            .contains("\"bytes\"")
    );

    Ok(())
}

#[tokio::test]
async fn retries_pending_event_without_creating_an_extra_revision() {
    let root = PathBuf::from("/workspace");
    let filesystem = Arc::new(MemoryFilesystem {
        root: root.clone(),
        bytes: Mutex::new(b"A".to_vec()),
    });
    let repository = Arc::new(OutboxRepository::default());
    let events = Arc::new(FailOnceEvents {
        fail: AtomicBool::new(true),
        ..FailOnceEvents::default()
    });
    let service = ArtifactService::new(repository.clone(), events.clone(), filesystem);
    let conversation_id = Uuid::new_v4();
    let turn_id = Uuid::new_v4();

    assert!(
        service
            .record(request(&root, conversation_id, turn_id))
            .await
            .is_err()
    );
    let recovered = service
        .record(request(&root, conversation_id, turn_id))
        .await
        .unwrap();

    assert_eq!(recovered.revision, 1);
    assert_eq!(repository.records.lock().unwrap().len(), 1);
    assert!(repository.pending.lock().unwrap().is_empty());
    assert_eq!(events.delivered.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn delivers_pending_revision_before_recording_changed_content() {
    let root = PathBuf::from("/workspace");
    let filesystem = Arc::new(MemoryFilesystem {
        root: root.clone(),
        bytes: Mutex::new(b"A".to_vec()),
    });
    let repository = Arc::new(OutboxRepository::default());
    let events = Arc::new(FailOnceEvents {
        fail: AtomicBool::new(true),
        ..FailOnceEvents::default()
    });
    let service = ArtifactService::new(repository.clone(), events.clone(), filesystem.clone());
    let conversation_id = Uuid::new_v4();
    let turn_id = Uuid::new_v4();

    assert!(
        service
            .record(request(&root, conversation_id, turn_id))
            .await
            .is_err()
    );
    *filesystem.bytes.lock().unwrap() = b"B".to_vec();
    let changed = service
        .record(request(&root, conversation_id, turn_id))
        .await
        .unwrap();

    assert_eq!(changed.revision, 2);
    assert_eq!(repository.records.lock().unwrap().len(), 2);
    assert!(repository.pending.lock().unwrap().is_empty());
    assert_eq!(events.delivered.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn rejects_parent_path_before_reading_content() {
    let root = PathBuf::from("/workspace");
    let filesystem = Arc::new(MemoryFilesystem {
        root: root.clone(),
        bytes: Mutex::new(b"secret".to_vec()),
    });
    let repository = Arc::new(MemoryRepository::default());
    let service = ArtifactService::new(
        repository.clone(),
        Arc::new(MemoryEvents::default()),
        filesystem,
    );
    let mut input = request(&root, Uuid::new_v4(), Uuid::new_v4());
    input.relative_path = PathBuf::from("../secret.xlsx");

    let error = service.record(input).await.unwrap_err();

    assert!(matches!(error, ArtifactServiceError::PathOutsideScope(_)));
    assert!(repository.0.lock().unwrap().is_empty());
}

struct EscapingFilesystem {
    root: PathBuf,
}

#[async_trait]
impl ArtifactFilesystem for EscapingFilesystem {
    async fn canonicalize(&self, path: &Path) -> Result<PathBuf, PortError> {
        if path == self.root {
            Ok(self.root.clone())
        } else {
            Ok(PathBuf::from("/outside/escaped.xlsx"))
        }
    }

    async fn read(&self, _path: &Path) -> Result<Vec<u8>, PortError> {
        panic!("symlink escape must be rejected before reading")
    }
}

#[tokio::test]
async fn rejects_canonicalized_symlink_escape() {
    let root = PathBuf::from("/workspace");
    let repository = Arc::new(MemoryRepository::default());
    let service = ArtifactService::new(
        repository.clone(),
        Arc::new(MemoryEvents::default()),
        Arc::new(EscapingFilesystem { root: root.clone() }),
    );

    let error = service
        .record(request(&root, Uuid::new_v4(), Uuid::new_v4()))
        .await
        .unwrap_err();

    assert!(matches!(error, ArtifactServiceError::PathOutsideScope(_)));
    assert!(repository.0.lock().unwrap().is_empty());
}
