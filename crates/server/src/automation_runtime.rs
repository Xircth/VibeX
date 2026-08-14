use std::{path::PathBuf, sync::Arc, time::Duration};

use async_trait::async_trait;
use automation::{
    AgentRuntimeVersionEvidence, AutomationEngine, AutomationRetentionService, AutomationRunner,
    ClaimedRun, ComponentVersionEvidence, ConnectionLaunch, IsolationSpec, PreparedWorkspace,
    ResolvedVersionEvidence, RetentionError, RetentionPolicy, RunError, RunExecutionRequest,
    RunStatus, StartupRecoveryReport, SystemClock, ToolLockVersionEvidence, TurnLaunchSpec,
    TurnLauncherPort, WorkspaceError, WorkspacePreparationRequest, WorkspacePreparerPort,
    WorkspaceRetentionPort,
};
use db::models::{
    automation_v2::{AutomationRunRecord, SqliteAutomationStore},
    conversation_turn::ConversationTurnRecord,
    project_repo::ProjectRepo,
    session::{CreateSession, Session},
    task::{CreateTask, Task, TaskStatus},
    workspace::{CreateWorkspace, Workspace},
    workspace_repo::{CreateWorkspaceRepo, WorkspaceRepo},
};
use deployment::Deployment;
use local_deployment::LocalDeployment;
use plugins::PromptBlock;
use uuid::Uuid;

#[derive(Clone)]
pub(crate) struct HeadlessAutomationRuntime {
    deployment: Arc<LocalDeployment>,
    conversation_context: conversations::ConversationContext,
    store: SqliteAutomationStore,
    plugin_control_plane: Arc<plugins::PluginControlPlane>,
}

impl HeadlessAutomationRuntime {
    pub(crate) fn new(
        deployment: Arc<LocalDeployment>,
        conversation_context: conversations::ConversationContext,
        plugin_control_plane: Arc<plugins::PluginControlPlane>,
    ) -> Self {
        Self {
            store: SqliteAutomationStore::new(deployment.db().pool.clone()),
            deployment,
            conversation_context,
            plugin_control_plane,
        }
    }

    pub(crate) async fn run(
        self,
        engine: AutomationEngine<std::fs::File>,
        recovery: Option<StartupRecoveryReport>,
    ) {
        if let Some(recovery) = recovery {
            for claimed in recovery.catch_up_runs {
                self.execute_claimed(claimed).await;
            }
        }
        let service = engine.with_claim_store(self.store.clone(), SystemClock);
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            if let Err(error) = self.reconcile_running_turns().await {
                tracing::warn!("headless Automation terminal reconciliation failed: {error}");
            }
            let retention = AutomationRetentionService::new(
                self.store.clone(),
                ServerRetentionWorkspaces {
                    deployment: self.deployment.clone(),
                },
                RetentionPolicy::default(),
            );
            if let Err(error) = retention.enforce(chrono::Utc::now()).await {
                tracing::warn!("headless Automation retention failed: {error}");
            }
            match service.tick().await {
                Ok(claimed) => {
                    for run in claimed {
                        let runtime = self.clone();
                        tokio::spawn(async move {
                            runtime.execute_claimed(run).await;
                        });
                    }
                }
                Err(error) => tracing::warn!("headless Automation tick failed: {error}"),
            }
        }
    }

    pub(crate) async fn execute_claimed(&self, claimed: ClaimedRun) {
        let automation = match self.store.find(claimed.automation_id).await {
            Ok(Some(automation)) => automation,
            Ok(None) => {
                let _ = automation::RunStorePort::settle(
                    &self.store,
                    claimed.run_id,
                    RunStatus::Failed,
                    Some("automation disappeared after claim".to_string()),
                )
                .await;
                return;
            }
            Err(error) => {
                tracing::warn!("headless Automation load after claim failed: {error}");
                return;
            }
        };
        let runner = AutomationRunner::new(
            self.store.clone(),
            ServerWorkspacePreparer {
                deployment: self.deployment.clone(),
                store: self.store.clone(),
            },
            ServerTurnLauncher {
                deployment: self.deployment.clone(),
                conversation_context: self.conversation_context.clone(),
                plugin_control_plane: self.plugin_control_plane.clone(),
            },
        );
        if let Err(error) = runner
            .execute(&RunExecutionRequest {
                run_id: claimed.run_id,
                automation_id: claimed.automation_id,
                launch_spec: automation.launch_spec,
            })
            .await
            && error != RunError::Cancelled
        {
            tracing::warn!(
                run_id = %claimed.run_id,
                "headless Automation run failed to launch: {error}"
            );
        }
    }

    pub(crate) async fn reconcile_running_turns(&self) -> Result<(), String> {
        for run in self
            .store
            .running_runs()
            .await
            .map_err(|error| error.to_string())?
        {
            self.reconcile_run_terminal(&run).await?;
            if run.snapshot.cancellation_requested
                && let Some(conversation_id) = run.snapshot.conversation_id
            {
                conversations::ConversationSessionService::new(self.conversation_context.clone())
                    .cancel_turn(
                        conversation_id,
                        Some("automation run cancelled".to_string()),
                    )
                    .await
                    .map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }

    async fn reconcile_run_terminal(&self, run: &AutomationRunRecord) -> Result<bool, String> {
        let Some(turn_id) = run.snapshot.turn_id else {
            return Ok(false);
        };
        let Some(turn) = ConversationTurnRecord::find_by_id(self.store.pool(), turn_id)
            .await
            .map_err(|error| error.to_string())?
        else {
            return Ok(false);
        };
        let terminal = match turn.status.as_str() {
            "completed" => Some((RunStatus::Completed, None)),
            "failed" => Some((
                RunStatus::Failed,
                turn.error_json
                    .or(turn.stop_reason)
                    .or_else(|| Some("conversation turn failed".to_string())),
            )),
            "cancelled" => Some((RunStatus::Cancelled, None)),
            "interrupted" => Some((RunStatus::Interrupted, turn.stop_reason)),
            _ => None,
        };
        let Some((status, error)) = terminal else {
            return Ok(false);
        };
        automation::RunStorePort::settle(&self.store, run.snapshot.run_id, status, error)
            .await
            .map_err(|error| error.to_string())
    }
}

#[derive(Clone)]
struct ServerRetentionWorkspaces {
    deployment: Arc<LocalDeployment>,
}

#[async_trait]
impl WorkspaceRetentionPort for ServerRetentionWorkspaces {
    async fn release_retained_workspace(&self, workspace_id: Uuid) -> Result<(), RetentionError> {
        let workspace = Workspace::find_by_id(&self.deployment.db().pool, workspace_id)
            .await
            .map_err(|error| RetentionError::Workspace(error.to_string()))?;
        if let Some(workspace) = workspace {
            self.deployment
                .container()
                .delete(&workspace)
                .await
                .map_err(|error| RetentionError::Workspace(error.to_string()))?;
        }
        Ok(())
    }
}

#[derive(Clone)]
struct ServerWorkspacePreparer {
    deployment: Arc<LocalDeployment>,
    store: SqliteAutomationStore,
}

#[async_trait]
impl WorkspacePreparerPort for ServerWorkspacePreparer {
    async fn prepare(
        &self,
        request: &WorkspacePreparationRequest,
    ) -> Result<PreparedWorkspace, WorkspaceError> {
        let pool = &self.deployment.db().pool;
        let repos = ProjectRepo::find_repos_for_project(pool, request.target.project_id)
            .await
            .map_err(adapter_error)?;
        if repos.is_empty() {
            return Err(WorkspaceError::Adapter(
                "automation project has no repository".to_string(),
            ));
        }

        let mut shared_root_leased = false;
        let workspace = match request.target.isolation {
            IsolationSpec::WorktreePerRun => {
                create_run_workspace(&self.deployment, request, &repos).await?
            }
            IsolationSpec::SharedInRoot => {
                if !self
                    .store
                    .try_acquire_shared_root(
                        &request.target.root_folder,
                        request.run_id,
                        chrono::Utc::now(),
                    )
                    .await
                    .map_err(adapter_error)?
                {
                    return Err(WorkspaceError::SharedRootBusy);
                }
                shared_root_leased = true;
                for repo in &repos {
                    if !self
                        .deployment
                        .git()
                        .is_worktree_clean(&repo.path)
                        .map_err(adapter_error)?
                    {
                        let _ = self.store.release_shared_root(request.run_id).await;
                        return Err(WorkspaceError::DirtySharedRoot);
                    }
                    let current = self
                        .deployment
                        .git()
                        .get_current_branch(&repo.path)
                        .map_err(adapter_error)?;
                    if let Some(expected) = request.target.branch.as_ref()
                        && expected != &current
                    {
                        let _ = self.store.release_shared_root(request.run_id).await;
                        return Err(WorkspaceError::WrongBranch {
                            expected: expected.clone(),
                            actual: current,
                        });
                    }
                }
                find_or_create_shared_workspace(&self.deployment, request, &repos).await?
            }
        };
        if let Err(error) = self
            .deployment
            .container()
            .ensure_container_exists(&workspace)
            .await
        {
            if shared_root_leased {
                let _ = self.store.release_shared_root(request.run_id).await;
            }
            return Err(adapter_error(error));
        }
        let workspace = Workspace::find_by_id(pool, workspace.id)
            .await
            .map_err(adapter_error)?
            .ok_or_else(|| WorkspaceError::Adapter("prepared workspace disappeared".to_string()))?;
        Ok(PreparedWorkspace {
            workspace_id: workspace.id,
            root_folder: workspace
                .container_ref
                .unwrap_or_else(|| request.target.root_folder.clone()),
            branch: workspace.branch,
        })
    }

    async fn release(&self, workspace: &PreparedWorkspace) -> Result<(), WorkspaceError> {
        let isolation: Option<String> = sqlx::query_scalar(
            "SELECT a.isolation
             FROM automation_runs r
             JOIN automations a ON a.id = r.automation_id
             WHERE r.worktree_workspace_id = ?
             ORDER BY r.started_at DESC
             LIMIT 1",
        )
        .bind(workspace.workspace_id)
        .fetch_optional(&self.deployment.db().pool)
        .await
        .map_err(adapter_error)?;
        if isolation.as_deref() == Some("worktree_per_run")
            && let Some(workspace) =
                Workspace::find_by_id(&self.deployment.db().pool, workspace.workspace_id)
                    .await
                    .map_err(adapter_error)?
        {
            self.deployment
                .container()
                .delete(&workspace)
                .await
                .map_err(adapter_error)?;
        }
        Ok(())
    }
}

async fn create_run_workspace(
    deployment: &LocalDeployment,
    request: &WorkspacePreparationRequest,
    repos: &[db::models::repo::Repo],
) -> Result<Workspace, WorkspaceError> {
    let pool = &deployment.db().pool;
    let title = format!("Automation {}", request.automation_id);
    let task = Task::create(
        pool,
        &CreateTask {
            project_id: request.target.project_id,
            title: title.clone(),
            description: None,
            status: Some(TaskStatus::Todo),
            parent_workspace_id: None,
            image_ids: None,
        },
        Uuid::new_v4(),
    )
    .await
    .map_err(adapter_error)?;
    let agent_working_dir = match repos {
        [repo] => Some(repo.default_working_dir.as_deref().map_or_else(
            || repo.name.clone(),
            |subdir| {
                PathBuf::from(&repo.name)
                    .join(subdir)
                    .to_string_lossy()
                    .into_owned()
            },
        )),
        _ => None,
    };
    let workspace_id = Uuid::new_v4();
    let branch = format!(
        "automation/{}/run-{}",
        request.automation_id, request.run_id
    );
    let workspace = Workspace::create(
        pool,
        &CreateWorkspace {
            project_id: request.target.project_id,
            parent_workspace_id: None,
            branch: branch.clone(),
            container_ref: None,
            use_worktree: true,
            agent_working_dir,
        },
        workspace_id,
        task.id,
    )
    .await
    .map_err(adapter_error)?;
    Workspace::update(pool, workspace.id, None, None, Some(&title))
        .await
        .map_err(adapter_error)?;
    let links = repos
        .iter()
        .map(|repo| CreateWorkspaceRepo {
            repo_id: repo.id,
            target_branch: request
                .target
                .branch
                .clone()
                .or_else(|| repo.default_target_branch.clone())
                .unwrap_or_else(|| "main".to_string()),
        })
        .collect::<Vec<_>>();
    WorkspaceRepo::create_many(pool, workspace.id, &links)
        .await
        .map_err(adapter_error)?;
    Ok(workspace)
}

async fn find_or_create_shared_workspace(
    deployment: &LocalDeployment,
    request: &WorkspacePreparationRequest,
    repos: &[db::models::repo::Repo],
) -> Result<Workspace, WorkspaceError> {
    let pool = &deployment.db().pool;
    if let Some(workspace) = Workspace::fetch_by_project_id(pool, request.target.project_id)
        .await
        .map_err(adapter_error)?
        .into_iter()
        .find(|workspace| !workspace.use_worktree && !workspace.archived)
    {
        return Ok(workspace);
    }
    let task = Task::create(
        pool,
        &CreateTask {
            project_id: request.target.project_id,
            title: "Automation shared root".to_string(),
            description: None,
            status: Some(TaskStatus::Todo),
            parent_workspace_id: None,
            image_ids: None,
        },
        Uuid::new_v4(),
    )
    .await
    .map_err(adapter_error)?;
    let workspace = Workspace::create(
        pool,
        &CreateWorkspace {
            project_id: request.target.project_id,
            parent_workspace_id: None,
            branch: request
                .target
                .branch
                .clone()
                .unwrap_or_else(|| "main".to_string()),
            container_ref: Some(request.target.root_folder.clone()),
            use_worktree: false,
            agent_working_dir: repos
                .first()
                .and_then(|repo| repo.default_working_dir.clone()),
        },
        Uuid::new_v4(),
        task.id,
    )
    .await
    .map_err(adapter_error)?;
    WorkspaceRepo::create_many(
        pool,
        workspace.id,
        &repos
            .iter()
            .map(|repo| CreateWorkspaceRepo {
                repo_id: repo.id,
                target_branch: request
                    .target
                    .branch
                    .clone()
                    .or_else(|| repo.default_target_branch.clone())
                    .unwrap_or_else(|| "main".to_string()),
            })
            .collect::<Vec<_>>(),
    )
    .await
    .map_err(adapter_error)?;
    Ok(workspace)
}

#[derive(Clone)]
struct ServerTurnLauncher {
    deployment: Arc<LocalDeployment>,
    conversation_context: conversations::ConversationContext,
    plugin_control_plane: Arc<plugins::PluginControlPlane>,
}

#[async_trait]
impl TurnLauncherPort for ServerTurnLauncher {
    async fn resolve_versions(
        &self,
        spec: &TurnLaunchSpec,
        _workspace: &PreparedWorkspace,
    ) -> Result<ResolvedVersionEvidence, RunError> {
        let pool = &self.deployment.db().pool;
        let managed_lock: Option<(String, String)> = sqlx::query_as(
            "SELECT l.id, l.registry_version
             FROM agent_installation i
             JOIN agent_install_lock l ON l.id = i.current_lock_id
             WHERE i.agent_id = ?",
        )
        .bind(spec.agent.agent_id.as_str())
        .fetch_optional(pool)
        .await
        .map_err(launcher_error)?;
        let mut plugins = Vec::new();
        let mut tool_locks = Vec::new();
        let runtime_inventory = self
            .plugin_control_plane
            .runtime_inventory()
            .await
            .map_err(launcher_error)?;
        for action in &spec.plugin_actions {
            self.plugin_control_plane
                .resolve_action(action.plugin_id.as_str(), action.action.id.as_str())
                .await
                .map_err(launcher_error)?;
            let plugin = self
                .plugin_control_plane
                .plugin(action.plugin_id.as_str())
                .await
                .map_err(launcher_error)?
                .ok_or_else(|| {
                    RunError::Launcher(format!(
                        "plugin {} is unavailable",
                        action.plugin_id.as_str()
                    ))
                })?;
            plugins.push(ComponentVersionEvidence {
                id: action.plugin_id.as_str().to_string(),
                version: plugin.version.clone(),
            });
            for required in &plugin.runtimes {
                let lock = runtime_inventory
                    .iter()
                    .find(|runtime| {
                        runtime.id == required.id
                            && required
                                .version
                                .as_deref()
                                .is_none_or(|version| version == runtime.version)
                    })
                    .ok_or_else(|| {
                        RunError::Launcher(format!(
                            "plugin {} Runtime {} is not ready",
                            action.plugin_id.as_str(),
                            required.id
                        ))
                    })?;
                tool_locks.push(ToolLockVersionEvidence {
                    tool_id: lock.id.clone(),
                    version: lock.version.clone(),
                    target: "user-global".to_owned(),
                    sha256: String::new(),
                });
            }
        }
        Ok(ResolvedVersionEvidence {
            agent_runtime: match managed_lock {
                Some((lock_id, registry_version)) => AgentRuntimeVersionEvidence::Managed {
                    agent_id: spec.agent.agent_id.to_string(),
                    registry_version,
                    lock_id,
                },
                None => AgentRuntimeVersionEvidence::External {
                    agent_id: spec.agent.agent_id.to_string(),
                    executor_profile: spec.agent.executor_profile_id.clone(),
                },
            },
            acp_adapter: ComponentVersionEvidence {
                id: "vibex-acp".to_string(),
                version: env!("CARGO_PKG_VERSION").to_string(),
            },
            plugins,
            tool_locks,
        })
    }

    async fn create_conversation(
        &self,
        spec: &TurnLaunchSpec,
        workspace: &PreparedWorkspace,
    ) -> Result<Uuid, RunError> {
        let workspace_row =
            Workspace::find_by_id(&self.deployment.db().pool, workspace.workspace_id)
                .await
                .map_err(launcher_error)?
                .ok_or_else(|| RunError::Launcher("workspace disappeared".to_string()))?;
        let id = Uuid::new_v4();
        Session::create(
            &self.deployment.db().pool,
            &CreateSession {
                executor: Some(spec.agent.agent_id.as_str().to_string()),
                agent_id: Some(spec.agent.agent_id.clone()),
                task_id: Some(workspace_row.task_id),
                name: spec.label_snapshot.clone(),
                initial_prompt: Some(spec.display_text.clone()),
                status: None,
            },
            id,
            workspace.workspace_id,
        )
        .await
        .map_err(launcher_error)?;
        Ok(id)
    }

    async fn create_connection(
        &self,
        _spec: &TurnLaunchSpec,
        _workspace: &PreparedWorkspace,
        _conversation_id: Uuid,
        _versions: &ResolvedVersionEvidence,
    ) -> Result<ConnectionLaunch, RunError> {
        Ok(ConnectionLaunch {
            connection_id: format!("automation-{}", Uuid::new_v4()),
        })
    }

    async fn start_turn(
        &self,
        spec: &TurnLaunchSpec,
        workspace: &PreparedWorkspace,
        conversation_id: Uuid,
        _connection_id: &str,
    ) -> Result<Uuid, RunError> {
        let mut prompt_parts = spec
            .prompt_blocks
            .iter()
            .map(|block| match block {
                PromptBlock::Text { text } => text.as_str(),
            })
            .filter(|text| !text.trim().is_empty())
            .collect::<Vec<_>>();
        prompt_parts.extend(spec.plugin_actions.iter().flat_map(|reference| {
            reference
                .action
                .prompt_blocks
                .iter()
                .map(|block| match block {
                    PromptBlock::Text { text } => text.as_str(),
                })
        }));
        let text = prompt_parts.join("\n");
        let (turn, _) =
            conversations::ConversationSessionService::new(self.conversation_context.clone())
                .start_turn_with_origin(
                    conversations::ConversationStartTurnInput {
                        agent_id: spec.agent.agent_id.clone(),
                        workspace_id: workspace.workspace_id,
                        conversation_id,
                        executor_profile_id: spec.agent.executor_profile_id.clone(),
                        text,
                        display_text: Some(spec.display_text.clone()),
                        images: Vec::new(),
                        mode_override: spec.mode_id.clone(),
                        config_overrides: spec.config_values.clone(),
                        plugin_actions: spec
                            .plugin_actions
                            .iter()
                            .map(|invocation| agents::ConversationPluginActionInvocation {
                                plugin_id: invocation.plugin_id.as_str().to_owned(),
                                action_id: invocation.action.id.as_str().to_owned(),
                            })
                            .collect(),
                    },
                    conversations::commit_reminder::AUTOMATION_ORIGIN,
                )
                .await
                .map_err(launcher_error)?;
        Ok(turn.turn_id)
    }
}

fn adapter_error(error: impl std::fmt::Display) -> WorkspaceError {
    WorkspaceError::Adapter(error.to_string())
}

fn launcher_error(error: impl std::fmt::Display) -> RunError {
    RunError::Launcher(error.to_string())
}
