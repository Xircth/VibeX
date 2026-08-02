use async_trait::async_trait;
use executors::profile::ExecutorProfileId;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

use crate::{
    GitWorkspacePort, PreparedWorkspace, TurnLaunchSpec, WorkspaceError,
    WorkspacePreparationRequest, WorkspaceService,
};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
    Skipped,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TurnTerminalState {
    Completed,
    Failed { error: String },
    Cancelled,
    Interrupted,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedVersionEvidence {
    pub agent_runtime: AgentRuntimeVersionEvidence,
    pub acp_adapter: ComponentVersionEvidence,
    pub plugins: Vec<ComponentVersionEvidence>,
    pub tool_locks: Vec<ToolLockVersionEvidence>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "ownership", rename_all = "snake_case")]
pub enum AgentRuntimeVersionEvidence {
    Managed {
        agent_id: String,
        registry_version: String,
        lock_id: String,
    },
    External {
        agent_id: String,
        executor_profile: Option<ExecutorProfileId>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentVersionEvidence {
    pub id: String,
    pub version: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolLockVersionEvidence {
    pub tool_id: String,
    pub version: String,
    pub target: String,
    pub sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunSnapshot {
    pub run_id: Uuid,
    pub automation_id: Uuid,
    pub status: RunStatus,
    pub cancellation_requested: bool,
    pub workspace_id: Option<Uuid>,
    pub conversation_id: Option<Uuid>,
    pub turn_id: Option<Uuid>,
    pub connection_id: Option<String>,
    pub resolved_versions: Option<ResolvedVersionEvidence>,
    pub error: Option<String>,
}

impl RunSnapshot {
    pub fn running(run_id: Uuid, automation_id: Uuid) -> Self {
        Self {
            run_id,
            automation_id,
            status: RunStatus::Running,
            cancellation_requested: false,
            workspace_id: None,
            conversation_id: None,
            turn_id: None,
            connection_id: None,
            resolved_versions: None,
            error: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RunExecutionRequest {
    pub run_id: Uuid,
    pub automation_id: Uuid,
    pub launch_spec: TurnLaunchSpec,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConnectionLaunch {
    pub connection_id: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TurnLaunchCorrelation {
    pub conversation_id: Uuid,
    pub connection_id: String,
    pub resolved_versions: ResolvedVersionEvidence,
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum RunError {
    #[error("automation run store failed: {0}")]
    Store(String),
    #[error("{0}")]
    Workspace(WorkspaceError),
    #[error("turn launcher failed: {0}")]
    Launcher(String),
    #[error("automation run was cancelled")]
    Cancelled,
}

impl RunError {
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Store(_) => "automation_run_store_failed",
            Self::Workspace(error) => error.code(),
            Self::Launcher(_) => "automation_turn_launcher_failed",
            Self::Cancelled => "automation_run_cancelled",
        }
    }
}

#[async_trait]
pub trait RunStorePort: Clone + Send + Sync + 'static {
    async fn cancellation_requested(&self, run_id: Uuid) -> Result<bool, RunError>;
    async fn attach_workspace(
        &self,
        run_id: Uuid,
        workspace: &PreparedWorkspace,
    ) -> Result<(), RunError>;
    async fn attach_launch(
        &self,
        run_id: Uuid,
        launch: &TurnLaunchCorrelation,
    ) -> Result<(), RunError>;
    async fn attach_turn(&self, run_id: Uuid, turn_id: Uuid) -> Result<(), RunError>;
    async fn settle(
        &self,
        run_id: Uuid,
        status: RunStatus,
        error: Option<String>,
    ) -> Result<bool, RunError>;
}

#[async_trait]
pub trait WorkspacePreparerPort: Clone + Send + Sync + 'static {
    async fn prepare(
        &self,
        request: &WorkspacePreparationRequest,
    ) -> Result<PreparedWorkspace, WorkspaceError>;

    async fn release(&self, _workspace: &PreparedWorkspace) -> Result<(), WorkspaceError> {
        Ok(())
    }
}

#[async_trait]
impl<G> WorkspacePreparerPort for WorkspaceService<G>
where
    G: GitWorkspacePort,
{
    async fn prepare(
        &self,
        request: &WorkspacePreparationRequest,
    ) -> Result<PreparedWorkspace, WorkspaceError> {
        WorkspaceService::prepare(self, request).await
    }
}

#[async_trait]
pub trait TurnLauncherPort: Clone + Send + Sync + 'static {
    async fn resolve_versions(
        &self,
        spec: &TurnLaunchSpec,
        workspace: &PreparedWorkspace,
    ) -> Result<ResolvedVersionEvidence, RunError>;
    async fn create_conversation(
        &self,
        spec: &TurnLaunchSpec,
        workspace: &PreparedWorkspace,
    ) -> Result<Uuid, RunError>;
    async fn create_connection(
        &self,
        spec: &TurnLaunchSpec,
        workspace: &PreparedWorkspace,
        conversation_id: Uuid,
        versions: &ResolvedVersionEvidence,
    ) -> Result<ConnectionLaunch, RunError>;
    async fn cancel_connection(&self, _connection_id: &str) -> Result<(), RunError> {
        Ok(())
    }
    async fn start_turn(
        &self,
        spec: &TurnLaunchSpec,
        workspace: &PreparedWorkspace,
        conversation_id: Uuid,
        connection_id: &str,
    ) -> Result<Uuid, RunError>;
}

#[derive(Clone, Debug)]
pub struct AutomationRunner<S, W, T> {
    store: S,
    workspace: W,
    launcher: T,
}

impl<S, W, T> AutomationRunner<S, W, T>
where
    S: RunStorePort,
    W: WorkspacePreparerPort,
    T: TurnLauncherPort,
{
    pub fn new(store: S, workspace: W, launcher: T) -> Self {
        Self {
            store,
            workspace,
            launcher,
        }
    }

    pub async fn execute(&self, request: &RunExecutionRequest) -> Result<(), RunError> {
        self.cancellation_checkpoint(request.run_id).await?;
        let workspace = match self
            .workspace
            .prepare(&WorkspacePreparationRequest {
                automation_id: request.automation_id,
                run_id: request.run_id,
                target: request.launch_spec.workspace.clone(),
            })
            .await
        {
            Ok(workspace) => workspace,
            Err(error) => {
                let _ = self
                    .store
                    .settle(request.run_id, RunStatus::Failed, Some(error.to_string()))
                    .await?;
                return Err(RunError::Workspace(error));
            }
        };
        if let Err(error) = self
            .store
            .attach_workspace(request.run_id, &workspace)
            .await
        {
            self.fail_after_workspace(request.run_id, &workspace, None, &error)
                .await;
            return Err(error);
        }
        if self.store.cancellation_requested(request.run_id).await? {
            let release_result = self.workspace.release(&workspace).await;
            self.settle_cancelled(request.run_id).await?;
            release_result.map_err(RunError::Workspace)?;
            return Err(RunError::Cancelled);
        }

        let versions = match self
            .launcher
            .resolve_versions(&request.launch_spec, &workspace)
            .await
        {
            Ok(versions) => versions,
            Err(error) => {
                self.fail_after_workspace(request.run_id, &workspace, None, &error)
                    .await;
                return Err(error);
            }
        };
        if self.store.cancellation_requested(request.run_id).await? {
            self.cancel_after_workspace(request.run_id, &workspace)
                .await?;
            return Err(RunError::Cancelled);
        }
        let conversation_id = match self
            .launcher
            .create_conversation(&request.launch_spec, &workspace)
            .await
        {
            Ok(conversation_id) => conversation_id,
            Err(error) => {
                self.fail_after_workspace(request.run_id, &workspace, None, &error)
                    .await;
                return Err(error);
            }
        };
        if self.store.cancellation_requested(request.run_id).await? {
            self.cancel_after_workspace(request.run_id, &workspace)
                .await?;
            return Err(RunError::Cancelled);
        }
        let connection = match self
            .launcher
            .create_connection(&request.launch_spec, &workspace, conversation_id, &versions)
            .await
        {
            Ok(connection) => connection,
            Err(error) => {
                self.fail_after_workspace(request.run_id, &workspace, None, &error)
                    .await;
                return Err(error);
            }
        };
        if let Err(error) = self
            .store
            .attach_launch(
                request.run_id,
                &TurnLaunchCorrelation {
                    conversation_id,
                    connection_id: connection.connection_id.clone(),
                    resolved_versions: versions,
                },
            )
            .await
        {
            self.fail_after_workspace(
                request.run_id,
                &workspace,
                Some(&connection.connection_id),
                &error,
            )
            .await;
            return Err(error);
        }
        if self.store.cancellation_requested(request.run_id).await? {
            self.cleanup_cancelled(request.run_id, &workspace, &connection.connection_id)
                .await?;
            return Err(RunError::Cancelled);
        }

        let turn_id = match self
            .launcher
            .start_turn(
                &request.launch_spec,
                &workspace,
                conversation_id,
                &connection.connection_id,
            )
            .await
        {
            Ok(turn_id) => turn_id,
            Err(error) => {
                self.fail_after_workspace(
                    request.run_id,
                    &workspace,
                    Some(&connection.connection_id),
                    &error,
                )
                .await;
                return Err(error);
            }
        };
        if let Err(error) = self.store.attach_turn(request.run_id, turn_id).await {
            self.fail_after_workspace(
                request.run_id,
                &workspace,
                Some(&connection.connection_id),
                &error,
            )
            .await;
            return Err(error);
        }
        Ok(())
    }

    pub async fn observe_terminal(
        &self,
        run_id: Uuid,
        terminal: TurnTerminalState,
    ) -> Result<bool, RunError> {
        let (status, error) = match terminal {
            TurnTerminalState::Completed => (RunStatus::Completed, None),
            TurnTerminalState::Failed { error } => (RunStatus::Failed, Some(error)),
            TurnTerminalState::Cancelled => (RunStatus::Cancelled, None),
            TurnTerminalState::Interrupted => (RunStatus::Interrupted, None),
        };
        self.store.settle(run_id, status, error).await
    }

    async fn cancellation_checkpoint(&self, run_id: Uuid) -> Result<(), RunError> {
        if self.store.cancellation_requested(run_id).await? {
            self.settle_cancelled(run_id).await?;
            return Err(RunError::Cancelled);
        }
        Ok(())
    }

    async fn cleanup_cancelled(
        &self,
        run_id: Uuid,
        workspace: &PreparedWorkspace,
        connection_id: &str,
    ) -> Result<(), RunError> {
        let connection_result = self.launcher.cancel_connection(connection_id).await;
        let workspace_result = self.workspace.release(workspace).await;
        self.settle_cancelled(run_id).await?;
        connection_result?;
        workspace_result.map_err(RunError::Workspace)
    }

    async fn cancel_after_workspace(
        &self,
        run_id: Uuid,
        workspace: &PreparedWorkspace,
    ) -> Result<(), RunError> {
        let workspace_result = self.workspace.release(workspace).await;
        self.settle_cancelled(run_id).await?;
        workspace_result.map_err(RunError::Workspace)
    }

    async fn settle_cancelled(&self, run_id: Uuid) -> Result<(), RunError> {
        let _ = self
            .store
            .settle(run_id, RunStatus::Cancelled, None)
            .await?;
        Ok(())
    }

    async fn fail_after_workspace(
        &self,
        run_id: Uuid,
        workspace: &PreparedWorkspace,
        connection_id: Option<&str>,
        error: &RunError,
    ) {
        if let Some(connection_id) = connection_id {
            let _ = self.launcher.cancel_connection(connection_id).await;
        }
        let _ = self.workspace.release(workspace).await;
        let _ = self
            .store
            .settle(run_id, RunStatus::Failed, Some(error.to_string()))
            .await;
    }
}
