use std::{
    collections::{HashMap, HashSet},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use agents::{
    AgentId, ArtifactTrust, BoundaryError, InstallInvocation, InstallOrchestrator, InstallOutput,
    InstallRunner, LockedInstallSource, PlannedDistributionKind, PlannedInstallComponent,
    ResolvedInstallPlan,
};
use async_trait::async_trait;
use tokio_util::sync::CancellationToken;

struct ConcurrencyRunner {
    active: AtomicUsize,
    max_active: AtomicUsize,
    active_by_resource: Mutex<HashMap<String, usize>>,
    max_by_resource: Mutex<HashMap<String, usize>>,
    failures: HashSet<String>,
}

#[async_trait]
impl InstallRunner for ConcurrencyRunner {
    async fn run(&self, invocation: InstallInvocation) -> Result<InstallOutput, BoundaryError> {
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_active.fetch_max(active, Ordering::SeqCst);
        let resource = invocation
            .env
            .get("VIBEX_SHARED_RESOURCE")
            .cloned()
            .unwrap_or_else(|| "none".to_string());
        {
            let mut current = self.active_by_resource.lock().unwrap();
            let value = current.entry(resource.clone()).or_default();
            *value += 1;
            let mut maxima = self.max_by_resource.lock().unwrap();
            maxima
                .entry(resource.clone())
                .and_modify(|maximum| *maximum = (*maximum).max(*value))
                .or_insert(*value);
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
        self.active.fetch_sub(1, Ordering::SeqCst);
        *self
            .active_by_resource
            .lock()
            .unwrap()
            .get_mut(&resource)
            .unwrap() -= 1;
        let source = invocation.args.first().cloned().unwrap_or_default();
        Ok(InstallOutput {
            status_code: if self.failures.contains(&source) {
                1
            } else {
                0
            },
            stdout: b"installed API_KEY=super-secret".to_vec(),
            stderr: Vec::new(),
        })
    }
}

fn plan(
    id: &str,
    source: &str,
    kind: PlannedDistributionKind,
    version: &str,
) -> ResolvedInstallPlan {
    ResolvedInstallPlan {
        agent_id: AgentId::parse(id).unwrap(),
        source: LockedInstallSource::BuiltInProfile,
        version: version.to_string(),
        platform: "darwin-aarch64".to_string(),
        components: vec![PlannedInstallComponent {
            component_id: "runtime".to_string(),
            distribution_kind: kind,
            version: version.to_string(),
            resolved_source: source.to_string(),
            command: "installer".to_string(),
            args: Vec::new(),
            env: Default::default(),
            trust: ArtifactTrust::Tofu,
        }],
    }
}

#[tokio::test]
async fn orchestrator_keeps_membership_on_cancel_failure_or_interrupt() {
    let runner = Arc::new(ConcurrencyRunner {
        active: AtomicUsize::new(0),
        max_active: AtomicUsize::new(0),
        active_by_resource: Mutex::new(HashMap::new()),
        max_by_resource: Mutex::new(HashMap::new()),
        failures: HashSet::from(["fail".to_string()]),
    });
    let orchestrator = Arc::new(InstallOrchestrator::new(runner.clone()));

    let old = plan("codex", "old", PlannedDistributionKind::Binary, "1.0.0");
    orchestrator.add_membership(old.agent_id.clone()).await;
    orchestrator.seed_current(old.clone()).await;
    let failed = orchestrator
        .execute(
            plan("codex", "fail", PlannedDistributionKind::Binary, "2.0.0"),
            CancellationToken::new(),
        )
        .await;
    assert!(failed.is_err());
    let after_failure = orchestrator.snapshot(&old.agent_id).await.unwrap();
    assert!(after_failure.membership_present);
    assert_eq!(after_failure.current.unwrap().version, "1.0.0");

    let canceled = CancellationToken::new();
    canceled.cancel();
    assert!(
        orchestrator
            .execute(
                plan("codex", "new", PlannedDistributionKind::Binary, "2.0.0"),
                canceled,
            )
            .await
            .is_err()
    );
    assert_eq!(
        orchestrator
            .snapshot(&old.agent_id)
            .await
            .unwrap()
            .current
            .unwrap()
            .version,
        "1.0.0"
    );

    orchestrator
        .execute(
            plan("codex", "new", PlannedDistributionKind::Binary, "2.0.0"),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let updated = orchestrator.snapshot(&old.agent_id).await.unwrap();
    assert_eq!(updated.current.unwrap().version, "2.0.0");
    assert_eq!(updated.rollback.unwrap().version, "1.0.0");

    let binary_jobs = ["vendor-a", "vendor-b", "vendor-c"].map(|id| {
        let orchestrator = orchestrator.clone();
        tokio::spawn(async move {
            orchestrator
                .add_membership(AgentId::parse(id).unwrap())
                .await;
            orchestrator
                .execute(
                    plan(id, id, PlannedDistributionKind::Binary, "1.0.0"),
                    CancellationToken::new(),
                )
                .await
        })
    });
    for job in binary_jobs {
        job.await.unwrap().unwrap();
    }
    assert!(runner.max_active.load(Ordering::SeqCst) <= 2);

    let node_jobs = ["node-a", "node-b"].map(|id| {
        let orchestrator = orchestrator.clone();
        tokio::spawn(async move {
            orchestrator
                .add_membership(AgentId::parse(id).unwrap())
                .await;
            orchestrator
                .execute(
                    plan(id, id, PlannedDistributionKind::Npx, "1.0.0"),
                    CancellationToken::new(),
                )
                .await
        })
    });
    for job in node_jobs {
        job.await.unwrap().unwrap();
    }
    assert_eq!(
        runner.max_by_resource.lock().unwrap().get("node").copied(),
        Some(1)
    );

    for index in 0..25 {
        let _ = orchestrator
            .execute(
                plan(
                    "codex",
                    "fail",
                    PlannedDistributionKind::Binary,
                    &format!("3.0.{index}"),
                ),
                CancellationToken::new(),
            )
            .await;
    }
    let diagnostics = orchestrator.diagnostics(&old.agent_id).await;
    assert_eq!(diagnostics.len(), 20);
    assert!(
        diagnostics
            .iter()
            .all(|item| !item.contains("super-secret"))
    );
    assert!(diagnostics.iter().all(|item| item.contains("[REDACTED]")));
}
