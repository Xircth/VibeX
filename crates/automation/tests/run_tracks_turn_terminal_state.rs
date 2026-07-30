use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use async_trait::async_trait;
use automation::{
    AgentRuntimeVersionEvidence, AutomationRunner, ComponentVersionEvidence, ConnectionLaunch,
    PreparedWorkspace, ResolvedVersionEvidence, RunError, RunExecutionRequest, RunSnapshot,
    RunStatus, RunStorePort, ToolLockVersionEvidence, TurnLaunchCorrelation, TurnLaunchSpec,
    TurnLauncherPort, TurnTerminalState, WorkspaceError, WorkspacePreparationRequest,
    WorkspacePreparerPort,
};
use uuid::Uuid;

#[derive(Clone)]
struct FakeRunStore {
    runs: Arc<Mutex<HashMap<Uuid, RunSnapshot>>>,
}

impl FakeRunStore {
    fn running(run_id: Uuid, automation_id: Uuid) -> Self {
        Self {
            runs: Arc::new(Mutex::new(HashMap::from([(
                run_id,
                RunSnapshot::running(run_id, automation_id),
            )]))),
        }
    }

    fn snapshot(&self, run_id: Uuid) -> RunSnapshot {
        self.runs.lock().unwrap()[&run_id].clone()
    }
}

#[async_trait]
impl RunStorePort for FakeRunStore {
    async fn cancellation_requested(&self, run_id: Uuid) -> Result<bool, RunError> {
        Ok(self.snapshot(run_id).cancellation_requested)
    }

    async fn attach_workspace(
        &self,
        run_id: Uuid,
        workspace: &PreparedWorkspace,
    ) -> Result<(), RunError> {
        self.runs
            .lock()
            .unwrap()
            .get_mut(&run_id)
            .unwrap()
            .workspace_id = Some(workspace.workspace_id);
        Ok(())
    }

    async fn attach_launch(
        &self,
        run_id: Uuid,
        launch: &TurnLaunchCorrelation,
    ) -> Result<(), RunError> {
        let mut runs = self.runs.lock().unwrap();
        let run = runs.get_mut(&run_id).unwrap();
        run.conversation_id = Some(launch.conversation_id);
        run.connection_id = Some(launch.connection_id.clone());
        run.resolved_versions = Some(launch.resolved_versions.clone());
        Ok(())
    }

    async fn attach_turn(&self, run_id: Uuid, turn_id: Uuid) -> Result<(), RunError> {
        self.runs.lock().unwrap().get_mut(&run_id).unwrap().turn_id = Some(turn_id);
        Ok(())
    }

    async fn settle(
        &self,
        run_id: Uuid,
        status: RunStatus,
        error: Option<String>,
    ) -> Result<bool, RunError> {
        let mut runs = self.runs.lock().unwrap();
        let run = runs.get_mut(&run_id).unwrap();
        if run.status != RunStatus::Running {
            return Ok(false);
        }
        run.status = status;
        run.error = error;
        Ok(true)
    }
}

#[derive(Clone)]
struct FakeWorkspace;

#[async_trait]
impl WorkspacePreparerPort for FakeWorkspace {
    async fn prepare(
        &self,
        _request: &WorkspacePreparationRequest,
    ) -> Result<PreparedWorkspace, WorkspaceError> {
        Ok(PreparedWorkspace {
            workspace_id: Uuid::new_v4(),
            root_folder: "/tmp/run-worktree".to_string(),
            branch: "automation/test/run-test".to_string(),
        })
    }
}

#[derive(Clone, Default)]
struct ReleasingWorkspace {
    released: Arc<Mutex<usize>>,
}

#[async_trait]
impl WorkspacePreparerPort for ReleasingWorkspace {
    async fn prepare(
        &self,
        _request: &WorkspacePreparationRequest,
    ) -> Result<PreparedWorkspace, WorkspaceError> {
        Ok(PreparedWorkspace {
            workspace_id: Uuid::new_v4(),
            root_folder: "/tmp/failing-run-worktree".to_string(),
            branch: "automation/test/run-failing".to_string(),
        })
    }

    async fn release(&self, _workspace: &PreparedWorkspace) -> Result<(), WorkspaceError> {
        *self.released.lock().unwrap() += 1;
        Ok(())
    }
}

#[derive(Clone, Default)]
struct FakeTurnLauncher {
    start_calls: Arc<Mutex<usize>>,
}

#[async_trait]
impl TurnLauncherPort for FakeTurnLauncher {
    async fn resolve_versions(
        &self,
        _spec: &TurnLaunchSpec,
        _workspace: &PreparedWorkspace,
    ) -> Result<ResolvedVersionEvidence, RunError> {
        Ok(ResolvedVersionEvidence {
            agent_runtime: AgentRuntimeVersionEvidence::Managed {
                agent_id: "codex".to_string(),
                registry_version: "1.2.3".to_string(),
                lock_id: "agent-lock-1".to_string(),
            },
            acp_adapter: ComponentVersionEvidence {
                id: "acp".to_string(),
                version: "1".to_string(),
            },
            plugins: vec![ComponentVersionEvidence {
                id: "vibex.office".to_string(),
                version: "2.0.0".to_string(),
            }],
            tool_locks: vec![ToolLockVersionEvidence {
                tool_id: "officecli".to_string(),
                version: "0.9.0".to_string(),
                target: "aarch64-apple-darwin".to_string(),
                sha256: "abc123".to_string(),
            }],
        })
    }

    async fn create_conversation(
        &self,
        _spec: &TurnLaunchSpec,
        _workspace: &PreparedWorkspace,
    ) -> Result<Uuid, RunError> {
        Ok(Uuid::new_v4())
    }

    async fn create_connection(
        &self,
        _spec: &TurnLaunchSpec,
        _workspace: &PreparedWorkspace,
        _conversation_id: Uuid,
        _versions: &ResolvedVersionEvidence,
    ) -> Result<ConnectionLaunch, RunError> {
        Ok(ConnectionLaunch {
            connection_id: "connection-1".to_string(),
        })
    }

    async fn start_turn(
        &self,
        _spec: &TurnLaunchSpec,
        _workspace: &PreparedWorkspace,
        _conversation_id: Uuid,
        _connection_id: &str,
    ) -> Result<Uuid, RunError> {
        *self.start_calls.lock().unwrap() += 1;
        Ok(Uuid::new_v4())
    }
}

#[derive(Clone)]
struct FailingTurnLauncher;

#[async_trait]
impl TurnLauncherPort for FailingTurnLauncher {
    async fn resolve_versions(
        &self,
        _spec: &TurnLaunchSpec,
        _workspace: &PreparedWorkspace,
    ) -> Result<ResolvedVersionEvidence, RunError> {
        Err(RunError::Launcher("agent version unavailable".to_string()))
    }

    async fn create_conversation(
        &self,
        _spec: &TurnLaunchSpec,
        _workspace: &PreparedWorkspace,
    ) -> Result<Uuid, RunError> {
        unreachable!("version resolution failed first")
    }

    async fn create_connection(
        &self,
        _spec: &TurnLaunchSpec,
        _workspace: &PreparedWorkspace,
        _conversation_id: Uuid,
        _versions: &ResolvedVersionEvidence,
    ) -> Result<ConnectionLaunch, RunError> {
        unreachable!("version resolution failed first")
    }

    async fn start_turn(
        &self,
        _spec: &TurnLaunchSpec,
        _workspace: &PreparedWorkspace,
        _conversation_id: Uuid,
        _connection_id: &str,
    ) -> Result<Uuid, RunError> {
        unreachable!("version resolution failed first")
    }
}

fn launch_spec() -> TurnLaunchSpec {
    serde_json::from_value(serde_json::json!({
        "specVersion": 1,
        "promptBlocks": [{ "type": "text", "text": "Run the review" }],
        "displayText": "Run the review",
        "agent": { "agentId": "codex", "executorProfileId": null },
        "modeId": null,
        "configValues": [],
        "pluginActions": [],
        "skills": [],
        "workspace": {
            "projectId": Uuid::new_v4(),
            "rootFolder": "/repo/vibex",
            "branch": "main",
            "isolation": "worktree_per_run"
        },
        "labelSnapshot": "Review"
    }))
    .expect("launch spec")
}

#[tokio::test]
async fn start_turn_success_keeps_the_run_running_until_terminal_event() {
    let run_id = Uuid::new_v4();
    let automation_id = Uuid::new_v4();
    let store = FakeRunStore::running(run_id, automation_id);
    let launcher = FakeTurnLauncher::default();
    let runner = AutomationRunner::new(store.clone(), FakeWorkspace, launcher.clone());

    runner
        .execute(&RunExecutionRequest {
            run_id,
            automation_id,
            launch_spec: launch_spec(),
        })
        .await
        .expect("launch succeeds");

    let run = store.snapshot(run_id);
    assert_eq!(run.status, RunStatus::Running);
    assert!(run.workspace_id.is_some());
    assert!(run.conversation_id.is_some());
    assert!(run.turn_id.is_some());
    assert!(run.resolved_versions.is_some());
    assert_eq!(*launcher.start_calls.lock().unwrap(), 1);
}

#[tokio::test]
async fn launch_failure_settles_failed_and_releases_the_prepared_workspace() {
    let run_id = Uuid::new_v4();
    let automation_id = Uuid::new_v4();
    let store = FakeRunStore::running(run_id, automation_id);
    let workspace = ReleasingWorkspace::default();
    let runner = AutomationRunner::new(store.clone(), workspace.clone(), FailingTurnLauncher);

    let error = runner
        .execute(&RunExecutionRequest {
            run_id,
            automation_id,
            launch_spec: launch_spec(),
        })
        .await
        .expect_err("version resolution must fail");

    assert_eq!(
        error,
        RunError::Launcher("agent version unavailable".to_string())
    );
    assert_eq!(store.snapshot(run_id).status, RunStatus::Failed);
    assert_eq!(*workspace.released.lock().unwrap(), 1);
}

#[tokio::test]
async fn completed_turn_settles_the_correlated_run_completed() {
    let run_id = Uuid::new_v4();
    let automation_id = Uuid::new_v4();
    let store = FakeRunStore::running(run_id, automation_id);
    let runner = AutomationRunner::new(store.clone(), FakeWorkspace, FakeTurnLauncher::default());

    let settled = runner
        .observe_terminal(run_id, TurnTerminalState::Completed)
        .await
        .expect("terminal projection");

    assert!(settled);
    assert_eq!(store.snapshot(run_id).status, RunStatus::Completed);
}

#[tokio::test]
async fn failed_turn_preserves_the_failure_on_the_run() {
    let run_id = Uuid::new_v4();
    let store = FakeRunStore::running(run_id, Uuid::new_v4());
    let runner = AutomationRunner::new(store.clone(), FakeWorkspace, FakeTurnLauncher::default());

    runner
        .observe_terminal(
            run_id,
            TurnTerminalState::Failed {
                error: "agent refused".to_string(),
            },
        )
        .await
        .expect("terminal projection");

    let run = store.snapshot(run_id);
    assert_eq!(run.status, RunStatus::Failed);
    assert_eq!(run.error.as_deref(), Some("agent refused"));
}

#[tokio::test]
async fn cancelled_turn_settles_the_run_cancelled() {
    let run_id = Uuid::new_v4();
    let store = FakeRunStore::running(run_id, Uuid::new_v4());
    let runner = AutomationRunner::new(store.clone(), FakeWorkspace, FakeTurnLauncher::default());

    runner
        .observe_terminal(run_id, TurnTerminalState::Cancelled)
        .await
        .expect("terminal projection");

    assert_eq!(store.snapshot(run_id).status, RunStatus::Cancelled);
}

#[tokio::test]
async fn interrupted_turn_settles_without_becoming_a_failure() {
    let run_id = Uuid::new_v4();
    let store = FakeRunStore::running(run_id, Uuid::new_v4());
    let runner = AutomationRunner::new(store.clone(), FakeWorkspace, FakeTurnLauncher::default());

    runner
        .observe_terminal(run_id, TurnTerminalState::Interrupted)
        .await
        .expect("terminal projection");

    let run = store.snapshot(run_id);
    assert_eq!(run.status, RunStatus::Interrupted);
    assert!(run.error.is_none());
}
