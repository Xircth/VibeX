use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};

use artifacts::{
    ArtifactEvent, ArtifactEventSink, ArtifactFilesystem, ArtifactRecord, ArtifactRepository,
    ArtifactService, ArtifactToolProvider, Clock, OfficeCliProvider, OfficeProcessId,
    OfficeProcessRuntime, OfficeProviderConfig, OpenPreview, PendingPreviewEvent, PortError,
    PreviewProviderRegistry, ProducerEvidence, ResolvedToolInstallation, TcpReadyProbe,
    ToolInstallationResolver, ToolLockEvidence,
};
use async_trait::async_trait;
use tool_runtime::ToolInstallationLock;
use uuid::Uuid;

struct Repository {
    records: Vec<ArtifactRecord>,
}

struct PreviewOutboxRepository {
    record: ArtifactRecord,
    outbox: Mutex<HashMap<String, (ArtifactEvent, bool)>>,
}

#[async_trait]
impl ArtifactRepository for PreviewOutboxRepository {
    async fn latest_for_path(
        &self,
        _conversation_id: Uuid,
        _scope_root: &Path,
        _relative_path: &Path,
    ) -> Result<Option<ArtifactRecord>, PortError> {
        Ok(Some(self.record.clone()))
    }

    async fn commit_revision(
        &self,
        _record: &ArtifactRecord,
        _event: &ArtifactEvent,
    ) -> Result<(), PortError> {
        Ok(())
    }

    async fn commit_preview_event(
        &self,
        key: &str,
        event: &ArtifactEvent,
    ) -> Result<bool, PortError> {
        let mut outbox = self.outbox.lock().unwrap();
        let entry = outbox
            .entry(key.to_owned())
            .or_insert_with(|| (event.clone(), false));
        Ok(!entry.1)
    }

    async fn pending_preview_events(
        &self,
        limit: usize,
    ) -> Result<Vec<PendingPreviewEvent>, PortError> {
        let mut pending = self
            .outbox
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, (_, delivered))| !*delivered)
            .map(|(key, (event, _))| PendingPreviewEvent {
                key: key.clone(),
                event: event.clone(),
            })
            .collect::<Vec<_>>();
        pending.sort_by(|left, right| left.key.cmp(&right.key));
        pending.truncate(limit);
        Ok(pending)
    }

    async fn mark_preview_event_delivered(&self, key: &str) -> Result<(), PortError> {
        if let Some((_, delivered)) = self.outbox.lock().unwrap().get_mut(key) {
            *delivered = true;
        }
        Ok(())
    }

    async fn find(&self, artifact_id: Uuid) -> Result<Option<ArtifactRecord>, PortError> {
        Ok((self.record.id == artifact_id).then(|| self.record.clone()))
    }
}

#[async_trait]
impl ArtifactRepository for Repository {
    async fn latest_for_path(
        &self,
        _conversation_id: Uuid,
        _scope_root: &Path,
        _relative_path: &Path,
    ) -> Result<Option<ArtifactRecord>, PortError> {
        Ok(self.records.first().cloned())
    }

    async fn commit_revision(
        &self,
        _record: &ArtifactRecord,
        _event: &ArtifactEvent,
    ) -> Result<(), PortError> {
        Ok(())
    }

    async fn find(&self, artifact_id: Uuid) -> Result<Option<ArtifactRecord>, PortError> {
        Ok(self
            .records
            .iter()
            .find(|record| record.id == artifact_id)
            .cloned())
    }
}

struct NoopEvents;

#[async_trait]
impl ArtifactEventSink for NoopEvents {
    async fn append(&self, _event: &ArtifactEvent) -> Result<(), PortError> {
        Ok(())
    }
}

#[derive(Default)]
struct FailOnceEvents {
    fail: AtomicBool,
    delivered: AtomicUsize,
}

#[async_trait]
impl ArtifactEventSink for FailOnceEvents {
    async fn append(&self, _event: &ArtifactEvent) -> Result<(), PortError> {
        if self.fail.swap(false, Ordering::SeqCst) {
            return Err(PortError::new("injected preview event failure"));
        }
        self.delivered.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

struct NoopFilesystem;

#[async_trait]
impl ArtifactFilesystem for NoopFilesystem {
    async fn canonicalize(&self, path: &Path) -> Result<PathBuf, PortError> {
        Ok(path.to_path_buf())
    }

    async fn read(&self, _path: &Path) -> Result<Vec<u8>, PortError> {
        Ok(Vec::new())
    }
}

struct Resolver(Option<ToolInstallationLock>);

#[async_trait]
impl ToolInstallationResolver for Resolver {
    async fn resolve(
        &self,
        evidence: &ToolLockEvidence,
    ) -> Result<Option<ResolvedToolInstallation>, PortError> {
        Ok(self.0.as_ref().and_then(|lock| {
            (evidence.tool_id == lock.tool_id
                && evidence.version == lock.version
                && evidence.sha256 == lock.sha256)
                .then(|| ResolvedToolInstallation::unleased(lock.clone()))
        }))
    }
}

#[derive(Default)]
struct FakeProcessRuntime {
    next_id: AtomicUsize,
    spawn_count: AtomicUsize,
    running: Mutex<HashSet<OfficeProcessId>>,
    ports: Mutex<HashMap<OfficeProcessId, u16>>,
    ready_error: Mutex<Option<String>>,
    block_ready: AtomicBool,
    ready_gate: tokio::sync::Notify,
    terminate_failures: AtomicUsize,
    resolved_file: Mutex<Option<PathBuf>>,
}

#[async_trait]
impl OfficeProcessRuntime for FakeProcessRuntime {
    async fn resolve_artifact_path(
        &self,
        scope_root: &Path,
        relative_path: &Path,
    ) -> Result<PathBuf, PortError> {
        Ok(self
            .resolved_file
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| scope_root.join(relative_path)))
    }

    async fn spawn(
        &self,
        executable: &Path,
        file: &Path,
        requested_port: u16,
    ) -> Result<OfficeProcessId, PortError> {
        assert!(executable.is_absolute());
        assert!(file.is_absolute());
        let id = OfficeProcessId(self.next_id.fetch_add(1, Ordering::SeqCst) as u64 + 1);
        self.spawn_count.fetch_add(1, Ordering::SeqCst);
        self.running.lock().unwrap().insert(id);
        self.ports.lock().unwrap().insert(id, requested_port);
        Ok(id)
    }

    async fn wait_ready_announcement(
        &self,
        process: OfficeProcessId,
        _timeout: Duration,
    ) -> Result<u16, PortError> {
        if self.block_ready.load(Ordering::SeqCst) {
            self.ready_gate.notified().await;
        }
        if let Some(error) = self.ready_error.lock().unwrap().take() {
            return Err(PortError::new(error));
        }
        self.ports
            .lock()
            .unwrap()
            .get(&process)
            .copied()
            .ok_or_else(|| PortError::new("process exited before ready"))
    }

    async fn is_running(&self, process: OfficeProcessId) -> Result<bool, PortError> {
        Ok(self.running.lock().unwrap().contains(&process))
    }

    async fn terminate(&self, process: OfficeProcessId) -> Result<(), PortError> {
        if self
            .terminate_failures
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |remaining| {
                remaining.checked_sub(1)
            })
            .is_ok()
        {
            return Err(PortError::new("injected terminate failure"));
        }
        self.running.lock().unwrap().remove(&process);
        Ok(())
    }
}

#[tokio::test]
async fn abort_during_readiness_terminates_pending_process() {
    let artifact = artifact();
    let runtime = Arc::new(FakeProcessRuntime::default());
    runtime.block_ready.store(true, Ordering::SeqCst);
    let service = preview_service(
        vec![artifact.clone()],
        runtime.clone(),
        Arc::new(FakeTcp),
        OfficeProviderConfig::default(),
        Some(lock_for(&artifact)),
    );
    let task = tokio::spawn(async move {
        service
            .open_preview(OpenPreview {
                artifact_id: artifact.id,
            })
            .await
    });
    while runtime.spawn_count.load(Ordering::SeqCst) == 0 {
        tokio::task::yield_now().await;
    }

    task.abort();
    let _ = task.await;
    for _ in 0..20 {
        if runtime.running.lock().unwrap().is_empty() {
            break;
        }
        tokio::task::yield_now().await;
    }

    assert!(runtime.running.lock().unwrap().is_empty());
}

struct FakeTcp;

#[async_trait]
impl TcpReadyProbe for FakeTcp {
    async fn wait_until_ready(&self, port: u16, _timeout: Duration) -> Result<(), PortError> {
        assert_ne!(port, 0);
        Ok(())
    }
}

struct FailingTcp;

#[async_trait]
impl TcpReadyProbe for FailingTcp {
    async fn wait_until_ready(&self, _port: u16, _timeout: Duration) -> Result<(), PortError> {
        Err(PortError::new("tcp ready timeout"))
    }
}

#[derive(Default)]
struct FakeClock(AtomicUsize);

impl Clock for FakeClock {
    fn now_unix_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst) as u64
    }
}

fn artifact() -> ArtifactRecord {
    let root = PathBuf::from("/workspace");
    ArtifactRecord {
        id: Uuid::new_v4(),
        conversation_id: Uuid::new_v4(),
        turn_id: Uuid::new_v4(),
        workspace_id: Some(Uuid::new_v4()),
        scope_root: root.clone(),
        relative_path: PathBuf::from("slides/demo.pptx"),
        media_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            .into(),
        content_hash: "b".repeat(64),
        revision: 1,
        producer: ProducerEvidence {
            plugin_id: "builtin.office".into(),
            plugin_version: "2.0.0".into(),
            provider_id: "officecli".into(),
            tool_lock: ToolLockEvidence {
                id: "lock-officecli-0.8.0".into(),
                tool_id: "officecli".into(),
                version: "0.8.0".into(),
                target: "aarch64-apple-darwin".into(),
                sha256: "a".repeat(64),
                executable_path: PathBuf::from("/managed/officecli/versions/0.8.0/officecli"),
            },
        },
        created_at_unix_ms: 1,
        updated_at_unix_ms: 1,
    }
}

fn lock_for(artifact: &ArtifactRecord) -> ToolInstallationLock {
    ToolInstallationLock {
        schema_version: 1,
        tool_id: "officecli".into(),
        version: "0.8.0".into(),
        target: "aarch64-apple-darwin".into(),
        source_url: "https://example.invalid/officecli".into(),
        sha256: "a".repeat(64),
        executable_path: artifact.producer.tool_lock.executable_path.clone(),
        installed_at_unix_ms: 1,
    }
}

fn preview_service(
    records: Vec<ArtifactRecord>,
    runtime: Arc<FakeProcessRuntime>,
    tcp: Arc<dyn TcpReadyProbe>,
    config: OfficeProviderConfig,
    lock: Option<ToolInstallationLock>,
) -> ArtifactService {
    let provider = Arc::new(OfficeCliProvider::new(
        runtime,
        tcp,
        Arc::new(FakeClock::default()),
        config,
    ));
    ArtifactService::new(
        Arc::new(Repository { records }),
        Arc::new(NoopEvents),
        Arc::new(NoopFilesystem),
    )
    .with_previews(
        PreviewProviderRegistry::from_providers([provider]).unwrap(),
        Arc::new(Resolver(lock)),
    )
}

#[tokio::test]
async fn office_preview_reuses_watch_process() {
    let artifact = artifact();
    let runtime = Arc::new(FakeProcessRuntime::default());
    let lock = lock_for(&artifact);
    let provider = Arc::new(OfficeCliProvider::new(
        runtime.clone(),
        Arc::new(FakeTcp),
        Arc::new(FakeClock::default()),
        OfficeProviderConfig::default(),
    ));
    let registry = PreviewProviderRegistry::from_providers([provider]).unwrap();
    let service = ArtifactService::new(
        Arc::new(Repository {
            records: vec![artifact.clone()],
        }),
        Arc::new(NoopEvents),
        Arc::new(NoopFilesystem),
    )
    .with_previews(registry, Arc::new(Resolver(Some(lock))));

    let first = service
        .open_preview(OpenPreview {
            artifact_id: artifact.id,
        })
        .await
        .unwrap();
    let second = service
        .open_preview(OpenPreview {
            artifact_id: artifact.id,
        })
        .await
        .unwrap();

    assert_eq!(runtime.spawn_count.load(Ordering::SeqCst), 1);
    assert_eq!(first.watch_key, second.watch_key);
    assert_eq!(second.reference_count, 2);
    assert!(first.capability_token.len() >= 32);
    assert!(first.docx_fallback_supported);

    service.close_preview(first.id).await.unwrap();
    assert!(runtime.running.lock().unwrap().len() == 1);
    service.close_preview(second.id).await.unwrap();
    assert!(runtime.running.lock().unwrap().is_empty());
}

#[tokio::test]
async fn failed_process_termination_keeps_close_retryable() {
    let artifact = artifact();
    let runtime = Arc::new(FakeProcessRuntime::default());
    let service = preview_service(
        vec![artifact.clone()],
        runtime.clone(),
        Arc::new(FakeTcp),
        OfficeProviderConfig::default(),
        Some(lock_for(&artifact)),
    );
    let lease = service
        .open_preview(OpenPreview {
            artifact_id: artifact.id,
        })
        .await
        .unwrap();
    runtime.terminate_failures.store(1, Ordering::SeqCst);

    assert!(service.close_preview(lease.id).await.is_err());
    assert_eq!(runtime.running.lock().unwrap().len(), 1);

    service.close_preview(lease.id).await.unwrap();
    assert!(runtime.running.lock().unwrap().is_empty());
}

#[tokio::test]
async fn unresolved_tool_never_starts_preview_process() {
    let artifact = artifact();
    let runtime = Arc::new(FakeProcessRuntime::default());
    let provider = Arc::new(OfficeCliProvider::new(
        runtime.clone(),
        Arc::new(FakeTcp),
        Arc::new(FakeClock::default()),
        OfficeProviderConfig::default(),
    ));
    let service = ArtifactService::new(
        Arc::new(Repository {
            records: vec![artifact.clone()],
        }),
        Arc::new(NoopEvents),
        Arc::new(NoopFilesystem),
    )
    .with_previews(
        PreviewProviderRegistry::from_providers([provider]).unwrap(),
        Arc::new(Resolver(None)),
    );

    let error = service
        .open_preview(OpenPreview {
            artifact_id: artifact.id,
        })
        .await
        .unwrap_err();

    assert!(matches!(
        error,
        artifacts::ArtifactServiceError::ToolUnresolved(_)
    ));
    assert_eq!(runtime.spawn_count.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn path_replaced_before_spawn_is_rejected() {
    let artifact = artifact();
    let runtime = Arc::new(FakeProcessRuntime::default());
    *runtime.resolved_file.lock().unwrap() = Some(PathBuf::from("/outside/demo.pptx"));
    let service = preview_service(
        vec![artifact.clone()],
        runtime.clone(),
        Arc::new(FakeTcp),
        OfficeProviderConfig::default(),
        Some(lock_for(&artifact)),
    );

    let error = service
        .open_preview(OpenPreview {
            artifact_id: artifact.id,
        })
        .await
        .unwrap_err();

    assert!(matches!(
        error,
        artifacts::ArtifactServiceError::PathOutsideScope(_)
    ));
    assert_eq!(runtime.spawn_count.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn preview_event_failure_is_recovered_from_durable_outbox() {
    let artifact = artifact();
    let runtime = Arc::new(FakeProcessRuntime::default());
    let provider = Arc::new(OfficeCliProvider::new(
        runtime.clone(),
        Arc::new(FakeTcp),
        Arc::new(FakeClock::default()),
        OfficeProviderConfig::default(),
    ));
    let events = Arc::new(FailOnceEvents {
        fail: AtomicBool::new(true),
        delivered: AtomicUsize::new(0),
    });
    let service = ArtifactService::new(
        Arc::new(PreviewOutboxRepository {
            record: artifact.clone(),
            outbox: Mutex::new(HashMap::new()),
        }),
        events.clone(),
        Arc::new(NoopFilesystem),
    )
    .with_previews(
        PreviewProviderRegistry::from_providers([provider]).unwrap(),
        Arc::new(Resolver(Some(lock_for(&artifact)))),
    );

    assert!(
        service
            .open_preview(OpenPreview {
                artifact_id: artifact.id,
            })
            .await
            .is_err()
    );
    assert!(runtime.running.lock().unwrap().is_empty());

    assert_eq!(service.flush_pending_preview_events().await.unwrap(), 2);
    assert_eq!(events.delivered.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn concurrent_preview_opens_share_one_process() {
    let artifact = artifact();
    let runtime = Arc::new(FakeProcessRuntime::default());
    let service = preview_service(
        vec![artifact.clone()],
        runtime.clone(),
        Arc::new(FakeTcp),
        OfficeProviderConfig::default(),
        Some(lock_for(&artifact)),
    );

    let (first, second) = tokio::join!(
        service.open_preview(OpenPreview {
            artifact_id: artifact.id
        }),
        service.open_preview(OpenPreview {
            artifact_id: artifact.id
        })
    );
    let first = first.unwrap();
    let second = second.unwrap();

    assert_eq!(runtime.spawn_count.load(Ordering::SeqCst), 1);
    assert_eq!(first.watch_key, second.watch_key);
}

#[tokio::test]
async fn crashed_process_is_replaced_without_stale_lease_closing_replacement() {
    let artifact = artifact();
    let runtime = Arc::new(FakeProcessRuntime::default());
    let service = preview_service(
        vec![artifact.clone()],
        runtime.clone(),
        Arc::new(FakeTcp),
        OfficeProviderConfig::default(),
        Some(lock_for(&artifact)),
    );
    let first = service
        .open_preview(OpenPreview {
            artifact_id: artifact.id,
        })
        .await
        .unwrap();
    runtime.running.lock().unwrap().clear();

    let replacement = service
        .open_preview(OpenPreview {
            artifact_id: artifact.id,
        })
        .await
        .unwrap();

    assert_eq!(runtime.spawn_count.load(Ordering::SeqCst), 2);
    assert_ne!(first.watch_key, replacement.watch_key);
    service.close_preview(first.id).await.unwrap();
    assert_eq!(runtime.running.lock().unwrap().len(), 1);
    service.close_preview(replacement.id).await.unwrap();
    assert!(runtime.running.lock().unwrap().is_empty());
}

#[tokio::test]
async fn ready_and_tcp_timeouts_reap_failed_processes() {
    let artifact = artifact();
    let runtime = Arc::new(FakeProcessRuntime::default());
    *runtime.ready_error.lock().unwrap() = Some("ready timeout".into());
    let service = preview_service(
        vec![artifact.clone()],
        runtime.clone(),
        Arc::new(FakeTcp),
        OfficeProviderConfig::default(),
        Some(lock_for(&artifact)),
    );
    assert!(
        service
            .open_preview(OpenPreview {
                artifact_id: artifact.id
            })
            .await
            .is_err()
    );
    assert!(runtime.running.lock().unwrap().is_empty());

    let tcp_runtime = Arc::new(FakeProcessRuntime::default());
    let tcp_service = preview_service(
        vec![artifact.clone()],
        tcp_runtime.clone(),
        Arc::new(FailingTcp),
        OfficeProviderConfig::default(),
        Some(lock_for(&artifact)),
    );
    assert!(
        tcp_service
            .open_preview(OpenPreview {
                artifact_id: artifact.id
            })
            .await
            .is_err()
    );
    assert!(tcp_runtime.running.lock().unwrap().is_empty());
}

#[tokio::test]
async fn process_limit_rejects_a_different_file() {
    let first = artifact();
    let mut second = artifact();
    second.relative_path = PathBuf::from("sheets/budget.xlsx");
    let runtime = Arc::new(FakeProcessRuntime::default());
    let service = preview_service(
        vec![first.clone(), second.clone()],
        runtime.clone(),
        Arc::new(FakeTcp),
        OfficeProviderConfig {
            max_processes: 1,
            ..OfficeProviderConfig::default()
        },
        Some(lock_for(&first)),
    );
    service
        .open_preview(OpenPreview {
            artifact_id: first.id,
        })
        .await
        .unwrap();

    let error = service
        .open_preview(OpenPreview {
            artifact_id: second.id,
        })
        .await
        .unwrap_err();

    assert!(matches!(
        error,
        artifacts::ArtifactServiceError::ProcessLimitReached
    ));
    assert_eq!(runtime.spawn_count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn expired_preview_lease_is_reaped() {
    let artifact = artifact();
    let runtime = Arc::new(FakeProcessRuntime::default());
    let clock = Arc::new(FakeClock::default());
    clock.0.store(100, Ordering::SeqCst);
    let provider = Arc::new(OfficeCliProvider::new(
        runtime.clone(),
        Arc::new(FakeTcp),
        clock.clone(),
        OfficeProviderConfig {
            idle_timeout: Duration::ZERO,
            lease_ttl: Duration::from_millis(10),
            ..OfficeProviderConfig::default()
        },
    ));
    let service = ArtifactService::new(
        Arc::new(Repository {
            records: vec![artifact.clone()],
        }),
        Arc::new(NoopEvents),
        Arc::new(NoopFilesystem),
    )
    .with_previews(
        PreviewProviderRegistry::from_providers([provider]).unwrap(),
        Arc::new(Resolver(Some(lock_for(&artifact)))),
    );
    service
        .open_preview(OpenPreview {
            artifact_id: artifact.id,
        })
        .await
        .unwrap();
    clock.0.store(111, Ordering::SeqCst);

    assert_eq!(service.reap_previews().await.unwrap(), 1);
    assert!(runtime.running.lock().unwrap().is_empty());
}

#[tokio::test]
async fn shared_provider_reap_report_routes_to_each_owning_service() {
    let first = artifact();
    let mut second = artifact();
    second.relative_path = PathBuf::from("sheets/budget.xlsx");
    let runtime = Arc::new(FakeProcessRuntime::default());
    let clock = Arc::new(FakeClock::default());
    let provider = Arc::new(OfficeCliProvider::new(
        runtime.clone(),
        Arc::new(FakeTcp),
        clock.clone(),
        OfficeProviderConfig {
            idle_timeout: Duration::ZERO,
            lease_ttl: Duration::from_millis(10),
            ..OfficeProviderConfig::default()
        },
    ));
    let first_service = ArtifactService::new(
        Arc::new(Repository {
            records: vec![first.clone()],
        }),
        Arc::new(NoopEvents),
        Arc::new(NoopFilesystem),
    )
    .with_previews(
        PreviewProviderRegistry::from_providers([provider.clone()]).unwrap(),
        Arc::new(Resolver(Some(lock_for(&first)))),
    );
    let second_service = ArtifactService::new(
        Arc::new(Repository {
            records: vec![second.clone()],
        }),
        Arc::new(NoopEvents),
        Arc::new(NoopFilesystem),
    )
    .with_previews(
        PreviewProviderRegistry::from_providers([provider.clone()]).unwrap(),
        Arc::new(Resolver(Some(lock_for(&second)))),
    );
    first_service
        .open_preview(OpenPreview {
            artifact_id: first.id,
        })
        .await
        .unwrap();
    second_service
        .open_preview(OpenPreview {
            artifact_id: second.id,
        })
        .await
        .unwrap();
    clock.0.store(11, Ordering::SeqCst);

    let report = provider.reap_idle().await.unwrap();
    first_service
        .apply_reap_report("officecli", report.clone())
        .await
        .unwrap();
    second_service
        .apply_reap_report("officecli", report)
        .await
        .unwrap();

    assert_eq!(first_service.shutdown_previews().await.unwrap(), 0);
    assert_eq!(second_service.shutdown_previews().await.unwrap(), 0);
    assert!(runtime.running.lock().unwrap().is_empty());
}

#[tokio::test]
async fn reap_report_is_owned_before_an_older_outbox_delivery_fails() {
    let artifact = artifact();
    let runtime = Arc::new(FakeProcessRuntime::default());
    let clock = Arc::new(FakeClock::default());
    let provider = Arc::new(OfficeCliProvider::new(
        runtime,
        Arc::new(FakeTcp),
        clock.clone(),
        OfficeProviderConfig {
            idle_timeout: Duration::ZERO,
            lease_ttl: Duration::from_millis(10),
            ..OfficeProviderConfig::default()
        },
    ));
    let repository = Arc::new(PreviewOutboxRepository {
        record: artifact.clone(),
        outbox: Mutex::new(HashMap::new()),
    });
    let events = Arc::new(FailOnceEvents::default());
    let service =
        ArtifactService::new(repository.clone(), events.clone(), Arc::new(NoopFilesystem))
            .with_previews(
                PreviewProviderRegistry::from_providers([provider.clone()]).unwrap(),
                Arc::new(Resolver(Some(lock_for(&artifact)))),
            );
    service
        .open_preview(OpenPreview {
            artifact_id: artifact.id,
        })
        .await
        .unwrap();
    repository.outbox.lock().unwrap().insert(
        "000-poison".into(),
        (
            ArtifactEvent::PreviewFailed {
                operation_id: Uuid::new_v4(),
                conversation_id: artifact.conversation_id,
                turn_id: artifact.turn_id,
                artifact_id: artifact.id,
                provider_id: "officecli".into(),
                message: "older pending event".into(),
            },
            false,
        ),
    );
    events.fail.store(true, Ordering::SeqCst);
    clock.0.store(11, Ordering::SeqCst);

    let report = provider.reap_idle().await.unwrap();
    assert!(
        service
            .apply_reap_report("officecli", report)
            .await
            .is_err()
    );
    assert_eq!(service.shutdown_previews().await.unwrap(), 0);
}
