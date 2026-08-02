use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Duration};

use async_trait::async_trait;
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::{
    ArtifactProviderDescriptor, ArtifactProviderProbe, ArtifactServiceError, ArtifactToolProvider,
    Clock, OfficeProcessRuntime, PreviewLease, PreviewReapReason, ProviderPreviewRequest,
    ProviderReapReport, ReapedPreviewLease, TcpReadyProbe,
};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct OfficeProcessId(pub u64);

#[derive(Clone, Debug)]
pub struct OfficeProviderConfig {
    pub max_processes: usize,
    pub ready_timeout: Duration,
    pub idle_timeout: Duration,
    pub lease_ttl: Duration,
}

impl Default for OfficeProviderConfig {
    fn default() -> Self {
        Self {
            max_processes: 32,
            ready_timeout: Duration::from_secs(15),
            idle_timeout: Duration::from_secs(5 * 60),
            lease_ttl: Duration::from_secs(5 * 60),
        }
    }
}

struct Watch {
    process: OfficeProcessId,
    watch_key: String,
    port: u16,
    reference_count: u32,
    last_used_unix_ms: u64,
}

struct ProviderState {
    watches: HashMap<PathBuf, Watch>,
    leases: HashMap<Uuid, LeaseEntry>,
}

#[derive(Clone)]
struct LeaseEntry {
    file: PathBuf,
    watch_key: String,
    artifact_id: Uuid,
    expires_at_unix_ms: u64,
}

pub struct OfficeCliProvider {
    processes: Arc<dyn OfficeProcessRuntime>,
    tcp: Arc<dyn TcpReadyProbe>,
    clock: Arc<dyn Clock>,
    config: OfficeProviderConfig,
    state: Mutex<ProviderState>,
}

struct PendingProcess {
    processes: Arc<dyn OfficeProcessRuntime>,
    process: Option<OfficeProcessId>,
}

impl PendingProcess {
    fn new(processes: Arc<dyn OfficeProcessRuntime>, process: OfficeProcessId) -> Self {
        Self {
            processes,
            process: Some(process),
        }
    }

    fn commit(mut self) {
        self.process = None;
    }
}

impl Drop for PendingProcess {
    fn drop(&mut self) {
        let Some(process) = self.process.take() else {
            return;
        };
        let processes = self.processes.clone();
        tokio::spawn(async move {
            let _ = processes.terminate(process).await;
        });
    }
}

impl OfficeCliProvider {
    pub fn new(
        processes: Arc<dyn OfficeProcessRuntime>,
        tcp: Arc<dyn TcpReadyProbe>,
        clock: Arc<dyn Clock>,
        config: OfficeProviderConfig,
    ) -> Self {
        Self {
            processes,
            tcp,
            clock,
            config,
            state: Mutex::new(ProviderState {
                watches: HashMap::new(),
                leases: HashMap::new(),
            }),
        }
    }

    fn lease(&self, artifact_id: Uuid, watch: &Watch, lease_id: Uuid) -> PreviewLease {
        PreviewLease {
            id: lease_id,
            artifact_id,
            provider_id: "officecli".into(),
            watch_key: watch.watch_key.clone(),
            loopback_port: watch.port,
            capability_token: Uuid::new_v4().simple().to_string(),
            expires_at_unix_ms: self
                .clock
                .now_unix_ms()
                .saturating_add(self.config.lease_ttl.as_millis() as u64),
            reference_count: watch.reference_count,
            docx_fallback_supported: true,
        }
    }
}

#[async_trait]
impl ArtifactToolProvider for OfficeCliProvider {
    fn descriptor(&self) -> ArtifactProviderDescriptor {
        ArtifactProviderDescriptor {
            id: "officecli".into(),
            supported_media_types: vec![
                "application/vnd.openxmlformats-officedocument.presentationml.presentation".into(),
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document".into(),
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".into(),
            ],
            max_concurrent_previews: self.config.max_processes,
        }
    }

    async fn probe(
        &self,
        tool: &tool_runtime::ToolInstallationLock,
    ) -> Result<ArtifactProviderProbe, ArtifactServiceError> {
        Ok(ArtifactProviderProbe {
            ready: tool.executable_path.is_absolute(),
            message: (!tool.executable_path.is_absolute())
                .then(|| "tool lock executable path is not absolute".into()),
        })
    }

    async fn open_preview(
        &self,
        request: ProviderPreviewRequest,
    ) -> Result<PreviewLease, ArtifactServiceError> {
        if !request.tool.executable_path.is_absolute() {
            return Err(ArtifactServiceError::Preview(
                "tool installation lock executable must be absolute".into(),
            ));
        }
        let file = request
            .artifact
            .scope_root
            .join(&request.artifact.relative_path);
        if !file.is_absolute() || !file.starts_with(&request.artifact.scope_root) {
            return Err(ArtifactServiceError::PathOutsideScope(
                request.artifact.relative_path.display().to_string(),
            ));
        }
        if !matches!(
            file.extension()
                .and_then(|extension| extension.to_str())
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("docx") | Some("xlsx") | Some("pptx")
        ) {
            return Err(ArtifactServiceError::Preview(
                "not a supported Office artifact".into(),
            ));
        }

        let mut state = self.state.lock().await;
        if let Some(existing) = state.watches.get(&file) {
            let running = self.processes.is_running(existing.process).await?;
            if !running {
                let process = existing.process;
                state.watches.remove(&file);
                let _ = self.processes.terminate(process).await;
            }
        }

        let lease_id = Uuid::new_v4();
        if state.watches.contains_key(&file) {
            let lease = {
                let watch = state.watches.get_mut(&file).expect("watch exists");
                watch.reference_count += 1;
                watch.last_used_unix_ms = self.clock.now_unix_ms();
                self.lease(request.artifact.id, watch, lease_id)
            };
            state.leases.insert(
                lease_id,
                LeaseEntry {
                    file,
                    watch_key: lease.watch_key.clone(),
                    artifact_id: request.artifact.id,
                    expires_at_unix_ms: lease.expires_at_unix_ms,
                },
            );
            return Ok(lease);
        }

        if state.watches.len() >= self.config.max_processes {
            return Err(ArtifactServiceError::ProcessLimitReached);
        }

        let verified_file = self
            .processes
            .resolve_artifact_path(
                &request.artifact.scope_root,
                &request.artifact.relative_path,
            )
            .await?;
        if verified_file != file {
            return Err(ArtifactServiceError::PathOutsideScope(
                request.artifact.relative_path.display().to_string(),
            ));
        }
        let requested_port = self.processes.allocate_port()?;
        let process = self
            .processes
            .spawn(&request.tool.executable_path, &file, requested_port)
            .await?;
        let pending_process = PendingProcess::new(self.processes.clone(), process);
        let announced = match self
            .processes
            .wait_ready_announcement(process, self.config.ready_timeout)
            .await
        {
            Ok(port) => port,
            Err(error) => {
                let _ = self.processes.terminate(process).await;
                return Err(error.into());
            }
        };
        if announced != requested_port {
            let _ = self.processes.terminate(process).await;
            return Err(ArtifactServiceError::Preview(format!(
                "office preview announced unexpected port {announced}"
            )));
        }
        if let Err(error) = self
            .tcp
            .wait_until_ready(announced, self.config.ready_timeout)
            .await
        {
            let _ = self.processes.terminate(process).await;
            return Err(error.into());
        }

        let watch = Watch {
            process,
            watch_key: Uuid::new_v4().to_string(),
            port: announced,
            reference_count: 1,
            last_used_unix_ms: self.clock.now_unix_ms(),
        };
        let lease = self.lease(request.artifact.id, &watch, lease_id);
        state.watches.insert(file.clone(), watch);
        state.leases.insert(
            lease_id,
            LeaseEntry {
                file,
                watch_key: lease.watch_key.clone(),
                artifact_id: request.artifact.id,
                expires_at_unix_ms: lease.expires_at_unix_ms,
            },
        );
        pending_process.commit();
        Ok(lease)
    }

    async fn close_preview(&self, lease_id: Uuid) -> Result<(), ArtifactServiceError> {
        let mut state = self.state.lock().await;
        let Some(lease) = state.leases.get(&lease_id).cloned() else {
            return Ok(());
        };
        let Some(watch) = state.watches.get_mut(&lease.file) else {
            // A crashed watch may already have been replaced. Closing its stale
            // lease must not decrement the replacement process.
            state.leases.remove(&lease_id);
            return Ok(());
        };
        if watch.watch_key != lease.watch_key {
            state.leases.remove(&lease_id);
            return Ok(());
        }
        if watch.reference_count > 1 {
            watch.reference_count -= 1;
            watch.last_used_unix_ms = self.clock.now_unix_ms();
            state.leases.remove(&lease_id);
        } else {
            let process = watch.process;
            self.processes.terminate(process).await?;
            state.leases.remove(&lease_id);
            state.watches.remove(&lease.file);
        }
        Ok(())
    }

    async fn reap_idle(&self) -> Result<ProviderReapReport, ArtifactServiceError> {
        let mut state = self.state.lock().await;
        let now = self.clock.now_unix_ms();
        let mut report = ProviderReapReport::default();
        let expired = state
            .leases
            .iter()
            .filter_map(|(lease_id, lease)| {
                (now >= lease.expires_at_unix_ms).then_some((*lease_id, lease.file.clone()))
            })
            .collect::<Vec<_>>();
        for (lease_id, file) in expired {
            let Some(lease) = state.leases.remove(&lease_id) else {
                continue;
            };
            report.leases.push(ReapedPreviewLease {
                lease_id,
                artifact_id: lease.artifact_id,
                reason: PreviewReapReason::Expired,
            });
            if let Some(watch) = state.watches.get_mut(&file)
                && watch.watch_key == lease.watch_key
            {
                watch.reference_count = watch.reference_count.saturating_sub(1);
            }
        }

        let files = state.watches.keys().cloned().collect::<Vec<_>>();
        for file in files {
            let Some(watch) = state.watches.get(&file) else {
                continue;
            };
            let running = self.processes.is_running(watch.process).await?;
            let idle_for = now.saturating_sub(watch.last_used_unix_ms);
            let idle_limit = self.config.idle_timeout.as_millis() as u64;
            if !running || (watch.reference_count == 0 && idle_for >= idle_limit) {
                let process = watch.process;
                let watch_key = watch.watch_key.clone();
                state.watches.remove(&file);
                if !running {
                    let crashed = state
                        .leases
                        .iter()
                        .filter_map(|(lease_id, lease)| {
                            (lease.watch_key == watch_key).then_some((*lease_id, lease.artifact_id))
                        })
                        .collect::<Vec<_>>();
                    for (lease_id, artifact_id) in crashed {
                        state.leases.remove(&lease_id);
                        report.leases.push(ReapedPreviewLease {
                            lease_id,
                            artifact_id,
                            reason: PreviewReapReason::Crashed,
                        });
                    }
                } else {
                    state.leases.retain(|_, lease| lease.watch_key != watch_key);
                }
                self.processes.terminate(process).await?;
                report.processes_reaped += 1;
            }
        }
        Ok(report)
    }
}
