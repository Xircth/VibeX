use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
};

use agents::AgentId;
use api_types::{
    AgentDiscoveryPhase, AgentDiscoveryProgressView, AgentLocalRuntimeView, AgentManagementView,
};
use tokio::sync::Mutex;

#[derive(Default)]
pub struct AgentManagementRuntimeState {
    warmup_complete: Mutex<bool>,
    local_runtime_discovery_complete: Mutex<bool>,
    local_runtime_discovery_progress: Mutex<LocalRuntimeDiscoveryProgress>,
    built_in_probes: Mutex<HashSet<AgentId>>,
    local_runtimes: Mutex<HashMap<AgentId, LocalRuntimeEvidence>>,
    acp_adapters: Mutex<HashMap<AgentId, LocalRuntimeEvidence>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalRuntimeEvidence {
    pub path: PathBuf,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LocalRuntimeDiscoveryProgress {
    pub started: bool,
    pub running: bool,
    pub completed: u32,
    pub total: u32,
    pub found: u32,
    pub checked_agent_ids: HashSet<AgentId>,
    pub timed_out: bool,
}

impl AgentManagementRuntimeState {
    pub async fn run_warmup_once<Fut>(&self, work: Fut)
    where
        Fut: std::future::Future<Output = ()>,
    {
        {
            let complete = self.warmup_complete.lock().await;
            if *complete {
                return;
            }
        }
        work.await;
        *self.warmup_complete.lock().await = true;
    }

    pub async fn run_local_runtime_discovery_once<Fut>(&self, work: Fut)
    where
        Fut: std::future::Future<Output = ()>,
    {
        {
            let complete = self.local_runtime_discovery_complete.lock().await;
            if *complete {
                return;
            }
        }
        work.await;
        *self.local_runtime_discovery_complete.lock().await = true;
    }

    pub async fn refresh_local_runtime_discovery<Fut>(&self, work: Fut)
    where
        Fut: std::future::Future<Output = ()>,
    {
        work.await;
        *self.local_runtime_discovery_complete.lock().await = true;
    }

    pub async fn reset(&self) {
        *self.warmup_complete.lock().await = false;
        *self.local_runtime_discovery_complete.lock().await = false;
        *self.local_runtime_discovery_progress.lock().await = Default::default();
        self.built_in_probes.lock().await.clear();
        self.local_runtimes.lock().await.clear();
        self.acp_adapters.lock().await.clear();
    }

    pub async fn begin_local_runtime_discovery(&self, total: u32) {
        *self.local_runtime_discovery_progress.lock().await = LocalRuntimeDiscoveryProgress {
            started: true,
            running: true,
            total,
            ..Default::default()
        };
    }

    pub async fn record_local_runtime_discovery(&self, agent_id: AgentId, found: bool) {
        let mut progress = self.local_runtime_discovery_progress.lock().await;
        if progress.checked_agent_ids.insert(agent_id) {
            progress.completed =
                u32::try_from(progress.checked_agent_ids.len()).unwrap_or(u32::MAX);
            if found {
                progress.found = progress.found.saturating_add(1);
            }
        }
    }

    pub async fn finish_local_runtime_discovery(&self, timed_out: bool) {
        let mut progress = self.local_runtime_discovery_progress.lock().await;
        progress.started = true;
        progress.running = false;
        progress.timed_out = timed_out;
    }

    pub async fn local_runtime_discovery_progress(&self) -> LocalRuntimeDiscoveryProgress {
        self.local_runtime_discovery_progress.lock().await.clone()
    }

    pub async fn should_probe_built_in(&self, agent_id: &AgentId, force: bool) -> bool {
        self.built_in_probes.lock().await.insert(agent_id.clone()) || force
    }

    pub async fn replace_local_runtime(
        &self,
        agent_id: AgentId,
        evidence: Option<LocalRuntimeEvidence>,
    ) {
        let mut local_runtimes = self.local_runtimes.lock().await;
        match evidence {
            Some(evidence) => {
                local_runtimes.insert(agent_id, evidence);
            }
            None => {
                local_runtimes.remove(&agent_id);
            }
        }
    }

    pub async fn local_runtime(&self, agent_id: &AgentId) -> Option<LocalRuntimeEvidence> {
        self.local_runtimes.lock().await.get(agent_id).cloned()
    }

    pub async fn local_runtimes(&self) -> HashMap<AgentId, LocalRuntimeEvidence> {
        self.local_runtimes.lock().await.clone()
    }

    pub async fn replace_acp_adapter(
        &self,
        agent_id: AgentId,
        evidence: Option<LocalRuntimeEvidence>,
    ) {
        let mut acp_adapters = self.acp_adapters.lock().await;
        match evidence {
            Some(evidence) => {
                acp_adapters.insert(agent_id, evidence);
            }
            None => {
                acp_adapters.remove(&agent_id);
            }
        }
    }

    pub async fn acp_adapters(&self) -> HashMap<AgentId, LocalRuntimeEvidence> {
        self.acp_adapters.lock().await.clone()
    }
}

pub fn local_runtime_discovery_progress_view(
    progress: LocalRuntimeDiscoveryProgress,
) -> AgentDiscoveryProgressView {
    let phase = if !progress.started {
        AgentDiscoveryPhase::Pending
    } else if progress.running {
        AgentDiscoveryPhase::Checking
    } else {
        AgentDiscoveryPhase::Complete
    };
    let mut checked_agent_ids = progress.checked_agent_ids.into_iter().collect::<Vec<_>>();
    checked_agent_ids.sort_by(|left, right| left.as_str().cmp(right.as_str()));
    AgentDiscoveryProgressView {
        phase,
        completed: progress.completed,
        total: progress.total,
        found: progress.found,
        checked_agent_ids,
        timed_out: progress.timed_out,
    }
}

pub async fn overlay_local_runtime_evidence(
    runtime: &AgentManagementRuntimeState,
    views: &mut [AgentManagementView],
) {
    let local_runtimes = runtime.local_runtimes().await;
    let acp_adapters = runtime.acp_adapters().await;
    for view in views {
        view.local_runtime =
            local_runtimes
                .get(&view.agent_id)
                .map(|evidence| AgentLocalRuntimeView {
                    path: evidence.path.display().to_string(),
                    version: evidence.version.clone(),
                });
        if view
            .acp_version
            .as_deref()
            .is_none_or(|version| version.is_empty())
            && let Some(version) = acp_adapters
                .get(&view.agent_id)
                .and_then(|evidence| evidence.version.clone())
                .filter(|version| !version.is_empty())
        {
            view.acp_version = Some(version);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use super::{AgentManagementRuntimeState, LocalRuntimeEvidence};

    #[tokio::test]
    async fn local_runtime_discovery_reports_real_progress() {
        let runtime = AgentManagementRuntimeState::default();
        let claude = agents::AgentId::parse("claude_code").unwrap();
        let codex = agents::AgentId::parse("codex").unwrap();

        runtime.begin_local_runtime_discovery(12).await;
        runtime
            .record_local_runtime_discovery(claude.clone(), true)
            .await;
        runtime
            .record_local_runtime_discovery(codex.clone(), false)
            .await;

        let progress = runtime.local_runtime_discovery_progress().await;
        assert!(progress.running);
        assert_eq!(progress.completed, 2);
        assert_eq!(progress.total, 12);
        assert_eq!(progress.found, 1);
        assert!(progress.checked_agent_ids.contains(&claude));
        assert!(progress.checked_agent_ids.contains(&codex));

        runtime.finish_local_runtime_discovery(false).await;
        let progress = runtime.local_runtime_discovery_progress().await;
        assert!(!progress.running);
        assert!(!progress.timed_out);
    }

    #[tokio::test]
    async fn local_data_reset_allows_agent_discovery_to_run_again() {
        let runtime = AgentManagementRuntimeState::default();
        let runs = Arc::new(AtomicUsize::new(0));
        let local_runs = Arc::new(AtomicUsize::new(0));

        let first_runs = runs.clone();
        runtime
            .run_warmup_once(async move {
                first_runs.fetch_add(1, Ordering::SeqCst);
            })
            .await;
        runtime
            .run_warmup_once(async {
                panic!("warmup must remain shared before reset");
            })
            .await;
        let first_local_runs = local_runs.clone();
        runtime
            .run_local_runtime_discovery_once(async move {
                first_local_runs.fetch_add(1, Ordering::SeqCst);
            })
            .await;
        runtime.run_local_runtime_discovery_once(async {}).await;

        runtime.reset().await;

        let second_runs = runs.clone();
        runtime
            .run_warmup_once(async move {
                second_runs.fetch_add(1, Ordering::SeqCst);
            })
            .await;
        let second_local_runs = local_runs.clone();
        runtime
            .run_local_runtime_discovery_once(async move {
                second_local_runs.fetch_add(1, Ordering::SeqCst);
            })
            .await;

        assert_eq!(runs.load(Ordering::SeqCst), 2);
        assert_eq!(local_runs.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn local_data_reset_forgets_previous_agent_probe_attempts() {
        let runtime = AgentManagementRuntimeState::default();
        let claude = agents::AgentId::parse("claude_code").unwrap();

        assert!(runtime.should_probe_built_in(&claude, false).await);
        assert!(!runtime.should_probe_built_in(&claude, false).await);
        runtime
            .replace_local_runtime(
                claude.clone(),
                Some(LocalRuntimeEvidence {
                    path: r"C:\Users\developer\AppData\Roaming\npm\claude.cmd".into(),
                    version: Some("2.1.173".to_string()),
                }),
            )
            .await;
        assert!(runtime.local_runtime(&claude).await.is_some());
        runtime
            .replace_acp_adapter(
                claude.clone(),
                Some(LocalRuntimeEvidence {
                    path: r"C:\Users\developer\AppData\Roaming\npm\claude-agent-acp.cmd".into(),
                    version: Some("0.69.0".to_string()),
                }),
            )
            .await;
        assert!(!runtime.acp_adapters().await.is_empty());

        runtime.reset().await;

        assert!(runtime.should_probe_built_in(&claude, false).await);
        assert!(runtime.local_runtime(&claude).await.is_none());
        assert!(runtime.acp_adapters().await.is_empty());
    }

    #[tokio::test]
    async fn discovery_once_does_not_hold_the_complete_flag_across_work() {
        let runtime = Arc::new(AgentManagementRuntimeState::default());
        let started = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let work_started = started.clone();
        let work_release = release.clone();
        let first_runtime = runtime.clone();
        let first = tokio::spawn(async move {
            first_runtime
                .run_local_runtime_discovery_once(async move {
                    work_started.notify_one();
                    work_release.notified().await;
                })
                .await;
        });
        started.notified().await;
        let progress_during_work = tokio::time::timeout(
            std::time::Duration::from_millis(200),
            runtime.local_runtime_discovery_progress(),
        )
        .await
        .expect("progress must not wait for discovery work");
        assert!(!progress_during_work.started);
        release.notify_one();
        first.await.expect("discovery task");
    }
}
