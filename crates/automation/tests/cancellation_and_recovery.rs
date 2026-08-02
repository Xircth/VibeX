use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use automation::{
    AgentRuntimeVersionEvidence, AutomationRunner, ClaimedRun, Clock, ComponentVersionEvidence,
    ConnectionLaunch, EngineError, PreparedWorkspace, RecoveryStorePort, ResolvedVersionEvidence,
    RunError, RunExecutionRequest, RunSnapshot, RunStatus, RunStorePort, StartupReconciler,
    TurnLaunchCorrelation, TurnLaunchSpec, TurnLauncherPort, WorkspaceError,
    WorkspacePreparationRequest, WorkspacePreparerPort,
};
use chrono::{DateTime, TimeZone, Utc};
use uuid::Uuid;

#[derive(Clone)]
struct CancelStore {
    state: Arc<Mutex<CancelState>>,
}

struct CancelState {
    snapshot: RunSnapshot,
    checks: usize,
    cancel_on_check: usize,
}

impl CancelStore {
    fn new(run_id: Uuid, automation_id: Uuid, cancel_on_check: usize) -> Self {
        Self {
            state: Arc::new(Mutex::new(CancelState {
                snapshot: RunSnapshot::running(run_id, automation_id),
                checks: 0,
                cancel_on_check,
            })),
        }
    }

    fn snapshot(&self) -> RunSnapshot {
        self.state.lock().unwrap().snapshot.clone()
    }
}

#[async_trait]
impl RunStorePort for CancelStore {
    async fn cancellation_requested(&self, _run_id: Uuid) -> Result<bool, RunError> {
        let mut state = self.state.lock().unwrap();
        state.checks += 1;
        if state.checks == state.cancel_on_check {
            state.snapshot.cancellation_requested = true;
        }
        Ok(state.snapshot.cancellation_requested)
    }

    async fn attach_workspace(
        &self,
        _run_id: Uuid,
        workspace: &PreparedWorkspace,
    ) -> Result<(), RunError> {
        self.state.lock().unwrap().snapshot.workspace_id = Some(workspace.workspace_id);
        Ok(())
    }

    async fn attach_launch(
        &self,
        _run_id: Uuid,
        launch: &TurnLaunchCorrelation,
    ) -> Result<(), RunError> {
        let mut state = self.state.lock().unwrap();
        state.snapshot.conversation_id = Some(launch.conversation_id);
        state.snapshot.connection_id = Some(launch.connection_id.clone());
        state.snapshot.resolved_versions = Some(launch.resolved_versions.clone());
        Ok(())
    }

    async fn attach_turn(&self, _run_id: Uuid, turn_id: Uuid) -> Result<(), RunError> {
        self.state.lock().unwrap().snapshot.turn_id = Some(turn_id);
        Ok(())
    }

    async fn settle(
        &self,
        _run_id: Uuid,
        status: RunStatus,
        error: Option<String>,
    ) -> Result<bool, RunError> {
        let mut state = self.state.lock().unwrap();
        if state.snapshot.status != RunStatus::Running {
            return Ok(false);
        }
        state.snapshot.status = status;
        state.snapshot.error = error;
        Ok(true)
    }
}

#[derive(Clone, Default)]
struct CountingWorkspace {
    prepared: Arc<Mutex<usize>>,
    released: Arc<Mutex<usize>>,
}

#[async_trait]
impl WorkspacePreparerPort for CountingWorkspace {
    async fn prepare(
        &self,
        _request: &WorkspacePreparationRequest,
    ) -> Result<PreparedWorkspace, WorkspaceError> {
        *self.prepared.lock().unwrap() += 1;
        Ok(PreparedWorkspace {
            workspace_id: Uuid::new_v4(),
            root_folder: "/tmp/worktree".to_string(),
            branch: "automation/run".to_string(),
        })
    }

    async fn release(&self, _workspace: &PreparedWorkspace) -> Result<(), WorkspaceError> {
        *self.released.lock().unwrap() += 1;
        Ok(())
    }
}

#[derive(Clone, Default)]
struct CountingLauncher {
    resolved: Arc<Mutex<usize>>,
    conversations: Arc<Mutex<usize>>,
    connections: Arc<Mutex<usize>>,
    cancelled_connections: Arc<Mutex<usize>>,
    turns: Arc<Mutex<usize>>,
}

#[async_trait]
impl TurnLauncherPort for CountingLauncher {
    async fn resolve_versions(
        &self,
        _spec: &TurnLaunchSpec,
        _workspace: &PreparedWorkspace,
    ) -> Result<ResolvedVersionEvidence, RunError> {
        *self.resolved.lock().unwrap() += 1;
        Ok(ResolvedVersionEvidence {
            agent_runtime: AgentRuntimeVersionEvidence::External {
                agent_id: "codex".to_string(),
                executor_profile: None,
            },
            acp_adapter: ComponentVersionEvidence {
                id: "acp".to_string(),
                version: "1".to_string(),
            },
            plugins: Vec::new(),
            tool_locks: Vec::new(),
        })
    }

    async fn create_conversation(
        &self,
        _spec: &TurnLaunchSpec,
        _workspace: &PreparedWorkspace,
    ) -> Result<Uuid, RunError> {
        *self.conversations.lock().unwrap() += 1;
        Ok(Uuid::new_v4())
    }

    async fn create_connection(
        &self,
        _spec: &TurnLaunchSpec,
        _workspace: &PreparedWorkspace,
        _conversation_id: Uuid,
        _versions: &ResolvedVersionEvidence,
    ) -> Result<ConnectionLaunch, RunError> {
        *self.connections.lock().unwrap() += 1;
        Ok(ConnectionLaunch {
            connection_id: "connection".to_string(),
        })
    }

    async fn cancel_connection(&self, _connection_id: &str) -> Result<(), RunError> {
        *self.cancelled_connections.lock().unwrap() += 1;
        Ok(())
    }

    async fn start_turn(
        &self,
        _spec: &TurnLaunchSpec,
        _workspace: &PreparedWorkspace,
        _conversation_id: Uuid,
        _connection_id: &str,
    ) -> Result<Uuid, RunError> {
        *self.turns.lock().unwrap() += 1;
        Ok(Uuid::new_v4())
    }
}

fn spec() -> TurnLaunchSpec {
    serde_json::from_value(serde_json::json!({
        "specVersion": 1,
        "promptBlocks": [{ "type": "text", "text": "Review" }],
        "displayText": "Review",
        "agent": { "agentId": "codex", "executorProfileId": null },
        "modeId": null,
        "configValues": [],
        "pluginActions": [],
        "skills": [],
        "workspace": {
            "projectId": Uuid::new_v4(),
            "rootFolder": "/repo",
            "branch": "main",
            "isolation": "worktree_per_run"
        }
    }))
    .unwrap()
}

#[derive(Clone)]
struct FixedClock(DateTime<Utc>);

impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        self.0
    }
}

#[derive(Clone)]
struct FakeRecoveryStore {
    running: Arc<Mutex<Vec<Uuid>>>,
    catch_up: Arc<Mutex<Option<ClaimedRun>>>,
}

#[async_trait]
impl RecoveryStorePort for FakeRecoveryStore {
    async fn interrupt_running(&self, _now: DateTime<Utc>) -> Result<Vec<Uuid>, EngineError> {
        Ok(std::mem::take(&mut *self.running.lock().unwrap()))
    }

    async fn claim_catch_up(&self, _now: DateTime<Utc>) -> Result<Vec<ClaimedRun>, EngineError> {
        Ok(self.catch_up.lock().unwrap().take().into_iter().collect())
    }
}

#[tokio::test]
async fn every_cancellation_window_stops_later_side_effects_and_cleans_up() {
    for cancel_on_check in 1..=5 {
        let run_id = Uuid::new_v4();
        let automation_id = Uuid::new_v4();
        let store = CancelStore::new(run_id, automation_id, cancel_on_check);
        let workspace = CountingWorkspace::default();
        let launcher = CountingLauncher::default();
        let runner = AutomationRunner::new(store.clone(), workspace.clone(), launcher.clone());

        let error = runner
            .execute(&RunExecutionRequest {
                run_id,
                automation_id,
                launch_spec: spec(),
            })
            .await
            .expect_err("planned cancellation");

        assert_eq!(error, RunError::Cancelled);
        assert_eq!(store.snapshot().status, RunStatus::Cancelled);
        assert_eq!(*launcher.turns.lock().unwrap(), 0);
        if cancel_on_check == 1 {
            assert_eq!(*workspace.prepared.lock().unwrap(), 0);
            assert_eq!(*workspace.released.lock().unwrap(), 0);
        } else {
            assert_eq!(*workspace.prepared.lock().unwrap(), 1);
            assert_eq!(*workspace.released.lock().unwrap(), 1);
        }
        assert_eq!(
            *launcher.resolved.lock().unwrap(),
            usize::from(cancel_on_check >= 3)
        );
        assert_eq!(
            *launcher.conversations.lock().unwrap(),
            usize::from(cancel_on_check >= 4)
        );
        if cancel_on_check >= 5 {
            assert_eq!(*launcher.connections.lock().unwrap(), 1);
            assert_eq!(*launcher.cancelled_connections.lock().unwrap(), 1);
        } else {
            assert_eq!(*launcher.connections.lock().unwrap(), 0);
            assert_eq!(*launcher.cancelled_connections.lock().unwrap(), 0);
        }
    }
}

#[tokio::test]
async fn startup_marks_crashed_runs_interrupted_without_relaunching_them() {
    let orphan = Uuid::new_v4();
    let store = FakeRecoveryStore {
        running: Arc::new(Mutex::new(vec![orphan])),
        catch_up: Arc::new(Mutex::new(None)),
    };
    let now = Utc.with_ymd_and_hms(2026, 7, 30, 9, 0, 0).single().unwrap();
    let reconciler = StartupReconciler::new(store, FixedClock(now));

    let report = reconciler.reconcile().await.expect("startup reconcile");

    assert_eq!(report.interrupted_run_ids, vec![orphan]);
    assert!(report.catch_up_runs.is_empty());
}

#[tokio::test]
async fn startup_catches_up_each_due_automation_at_most_once() {
    let now = Utc.with_ymd_and_hms(2026, 7, 30, 9, 0, 0).single().unwrap();
    let catch_up = ClaimedRun {
        run_id: Uuid::new_v4(),
        automation_id: Uuid::new_v4(),
        scheduled_for: now - chrono::Duration::hours(8),
        next_run_at: Some(now + chrono::Duration::hours(16)),
    };
    let store = FakeRecoveryStore {
        running: Arc::new(Mutex::new(Vec::new())),
        catch_up: Arc::new(Mutex::new(Some(catch_up.clone()))),
    };
    let reconciler = StartupReconciler::new(store, FixedClock(now));

    let first = reconciler.reconcile().await.expect("first reconcile");
    let second = reconciler.reconcile().await.expect("second reconcile");

    assert_eq!(first.catch_up_runs, vec![catch_up]);
    assert!(second.catch_up_runs.is_empty());
}
