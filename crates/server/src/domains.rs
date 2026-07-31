use std::sync::Arc;

use agents::{AgentId, SessionLaunchLock};
use application::{ApplicationDomainPort, ApplicationError, DomainCommand, Principal};
use artifacts::{ArtifactRepository, OpenPreview, SqliteArtifactRepository};
use async_trait::async_trait;
use automation::{
    AutomationDraft, AutomationDraftInput, BuiltinTemplateCatalog, ClaimedRun,
    PluginActionCatalogPort, RunStatus, ScheduleService, ScheduleSpec, SystemClock, TurnLaunchSpec,
};
use chrono::{DateTime, Utc};
use conversations::{ConversationContext, ConversationSessionService};
use db::models::{
    agent_capability_catalog::AgentCapabilityCatalogRecord,
    automation_v2::{AutomationRecord, AutomationRunRecord, SqliteAutomationStore},
    plugin::PluginV1Migration,
    project::Project,
    project_repo::ProjectRepo,
};
use deployment::Deployment;
use local_deployment::LocalDeployment;
use office_runtime::OfficeRuntime;
use plugins::{
    DependencyState, PluginActivation, PluginMembership, PluginReadiness, ProviderState, SkillState,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{PreviewProxyRegistry, automation_runtime::HeadlessAutomationRuntime};

#[derive(Clone)]
pub(crate) struct ServerApplicationDomains {
    pool: SqlitePool,
    office: Arc<OfficeRuntime>,
    preview_proxy: PreviewProxyRegistry,
    automation: HeadlessAutomationRuntime,
    owns_automation_engine: bool,
    conversations: ConversationContext,
    deployment: Arc<LocalDeployment>,
}

impl ServerApplicationDomains {
    pub(crate) fn new(
        pool: SqlitePool,
        office: Arc<OfficeRuntime>,
        preview_proxy: PreviewProxyRegistry,
        automation: HeadlessAutomationRuntime,
        owns_automation_engine: bool,
        conversations: ConversationContext,
        deployment: Arc<LocalDeployment>,
    ) -> Self {
        Self {
            pool,
            office,
            preview_proxy,
            automation,
            owns_automation_engine,
            conversations,
            deployment,
        }
    }

    fn automation_store(&self) -> SqliteAutomationStore {
        SqliteAutomationStore::new(self.pool.clone())
    }

    async fn execute_command(
        &self,
        command: DomainCommand,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        match command {
            DomainCommand::PluginActionCatalog => self.plugin_catalog(),
            DomainCommand::PluginLegacyMigrationList => self.legacy_plugins().await,
            DomainCommand::ProjectList => self.project_list().await,
            DomainCommand::ProjectRepositories => self.project_repositories(args).await,
            DomainCommand::RepoBranches => self.repo_branches(args).await,
            DomainCommand::AgentManagementBar => self.agent_management_bar().await,
            DomainCommand::AgentCapabilityCatalog => self.agent_capability_catalog(args).await,
            DomainCommand::UserSystemInfo => self.user_system_info().await,
            DomainCommand::OfficeCliInstall => self.install_office(args).await,
            DomainCommand::OfficeCliCancelInstall => self.cancel_office_install(args).await,
            DomainCommand::OfficePluginSetEnabled => self.set_office_enabled(args).await,
            DomainCommand::ArtifactList => self.artifact_list(args).await,
            DomainCommand::ArtifactOpenPreview => self.open_preview(args).await,
            DomainCommand::ArtifactClosePreview => self.close_preview(args).await,
            DomainCommand::AutomationList => self.automation_list().await,
            DomainCommand::AutomationEngineStatus => {
                Ok(json!({ "active": self.owns_automation_engine }))
            }
            DomainCommand::AutomationCreate => self.automation_create(args).await,
            DomainCommand::AutomationUpdate => self.automation_update(args).await,
            DomainCommand::AutomationSetEnabled => self.automation_set_enabled(args).await,
            DomainCommand::AutomationDelete => self.automation_delete(args).await,
            DomainCommand::AutomationRunNow => self.automation_run_now(args).await,
            DomainCommand::AutomationCancelRun => self.automation_cancel_run(args).await,
            DomainCommand::AutomationRuns => self.automation_runs(args).await,
            DomainCommand::AutomationPreviewNextRuns => self.automation_preview(args),
            DomainCommand::AutomationTemplates => self.automation_templates(),
            DomainCommand::AutomationUnseenFailures => self.automation_unseen_failures().await,
            DomainCommand::AutomationMarkSeen => self.automation_mark_seen().await,
            DomainCommand::DelegationCancel => self.delegation_cancel(args).await,
        }
    }

    fn plugin_catalog(&self) -> Result<Value, ApplicationError> {
        let manifest = self.office.bundled_plugin();
        let snapshot = self
            .office
            .bundled_plugin_snapshot()
            .map_err(internal_error)?;
        let dependency = snapshot
            .dependencies
            .iter()
            .next()
            .map(|(id, state)| dependency_json(id, state))
            .ok_or_else(|| ApplicationError::internal("Office dependency is missing"))?;
        let actions = manifest
            .actions
            .iter()
            .map(|action| {
                let prompt_blocks = action
                    .prompt_blocks
                    .iter()
                    .map(|block| match block {
                        plugins::PromptBlock::Text { text } => {
                            json!({ "type": "text", "text": text })
                        }
                    })
                    .collect::<Vec<_>>();
                json!({
                    "pluginId": manifest.id.as_str(),
                    "actionId": action.id.as_str(),
                    "label": action.label,
                    "requiredSkills": action.required_skills.iter()
                        .map(|id| id.as_str()).collect::<Vec<_>>(),
                    "requiredTools": action.required_tools.iter()
                        .map(|id| id.as_str()).collect::<Vec<_>>(),
                    "promptBlocks": prompt_blocks,
                    "artifactIntent": action.artifact_intent.as_ref().map(|intent| json!({
                        "mediaTypes": intent.media_types,
                        "provider": intent.provider,
                    })),
                })
            })
            .collect::<Vec<_>>();
        Ok(json!({
            "plugin": {
                "id": manifest.id.as_str(),
                "name": manifest.name,
                "version": manifest.version,
                "membership": match snapshot.membership {
                    PluginMembership::Builtin => "builtin",
                    PluginMembership::Added => "added",
                },
            },
            "actions": actions,
            "readiness": {
                "enabled": snapshot.activation == PluginActivation::Enabled,
                "dependency": dependency,
                "skills": snapshot.skills.iter()
                    .map(|(id, state)| skill_json(id, state)).collect::<Vec<_>>(),
                "providers": snapshot.providers.iter()
                    .map(|(id, state)| provider_json(id, state)).collect::<Vec<_>>(),
                "overall": match snapshot.readiness {
                    PluginReadiness::Ready => "ready",
                    PluginReadiness::NotReady { .. } => "not_ready",
                },
            },
        }))
    }

    async fn legacy_plugins(&self) -> Result<Value, ApplicationError> {
        let evidence = PluginV1Migration::migrate_all(&self.pool)
            .await
            .map_err(internal_error)?;
        Ok(Value::Array(
            evidence
                .into_iter()
                .map(|item| {
                    json!({
                        "legacyPluginId": item.legacy_plugin_id,
                        "name": item.original_manifest.get("name")
                            .and_then(Value::as_str).unwrap_or("Legacy plugin"),
                        "status": item.status,
                        "mappedPluginId": item.mapped_plugin_id,
                    })
                })
                .collect(),
        ))
    }

    async fn project_list(&self) -> Result<Value, ApplicationError> {
        serialize(
            Project::find_all(&self.pool)
                .await
                .map_err(internal_error)?,
        )
    }

    async fn project_repositories(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: IdArgs = parse(args)?;
        serialize(
            ProjectRepo::find_repos_for_project(&self.pool, args.id)
                .await
                .map_err(internal_error)?,
        )
    }

    async fn repo_branches(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: RepoIdArgs = parse(args)?;
        let repo = self
            .deployment
            .repo()
            .get_by_id(&self.pool, args.repo_id)
            .await
            .map_err(internal_error)?;
        serialize(
            self.deployment
                .git()
                .get_all_branches(&repo.path)
                .map_err(internal_error)?,
        )
    }

    async fn agent_management_bar(&self) -> Result<Value, ApplicationError> {
        serialize(
            services::services::agent_management::AgentManagementApplicationService::new(
                self.pool.clone(),
            )
            .list()
            .await
            .map_err(internal_error)?,
        )
    }

    async fn agent_capability_catalog(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AgentIdArgs = parse(args)?;
        let agent_id = AgentId::parse(args.agent_id).map_err(internal_error)?;
        let launch =
            match conversations::resolve_agent_runtime_launch_settings(&self.pool, &agent_id).await
            {
                Ok(launch) => launch,
                Err(_) => return Ok(Value::Null),
            };
        let fingerprint = capability_catalog_fingerprint(&launch.launch_lock);
        let record = AgentCapabilityCatalogRecord::find_matching(
            &self.pool,
            agent_id.as_str(),
            &fingerprint,
        )
        .await
        .map_err(internal_error)?;
        record
            .and_then(|record| serde_json::from_str(&record.controls_json).ok())
            .map_or(Ok(Value::Null), Ok)
    }

    async fn user_system_info(&self) -> Result<Value, ApplicationError> {
        let config = self.deployment.config().read().await.clone();
        Ok(json!({
            "config": config,
            "executors": {},
            "environment": {
                "os_type": std::env::consts::OS,
                "os_version": "headless",
                "os_architecture": std::env::consts::ARCH,
                "bitness": if usize::BITS == 64 { "64-bit" } else { "32-bit" },
            },
            "capabilities": {},
        }))
    }

    async fn install_office(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: TaskArgs = parse(args)?;
        require_nonempty(&args.task_id, "taskId")?;
        let lock = self
            .office
            .install(&args.task_id)
            .await
            .map_err(internal_error)?;
        Ok(json!({
            "installed": true,
            "version": lock.version,
            "path": lock.executable_path,
            "runtimeError": null,
        }))
    }

    async fn cancel_office_install(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: TaskArgs = parse(args)?;
        require_nonempty(&args.task_id, "taskId")?;
        Ok(json!(self.office.cancel_install(&args.task_id).await))
    }

    async fn set_office_enabled(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: EnableOfficeArgs = parse(args)?;
        require_nonempty(&args.task_id, "taskId")?;
        self.office
            .set_bundled_enabled(args.enabled, &args.task_id)
            .await
            .map_err(internal_error)?;
        self.plugin_catalog()
    }

    async fn artifact_list(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: ArtifactListArgs = parse(args)?;
        let ids = if let Some(conversation_id) = args.conversation_id {
            sqlx::query_scalar::<_, Uuid>(
                "SELECT id FROM artifact_revisions WHERE conversation_id = ? \
                 GROUP BY id ORDER BY MAX(updated_at_unix_ms) DESC LIMIT ?",
            )
            .bind(conversation_id)
            .bind(args.limit.unwrap_or(100).clamp(1, 200))
            .fetch_all(&self.pool)
            .await
            .map_err(internal_error)?
        } else {
            sqlx::query_scalar::<_, Uuid>(
                "SELECT id FROM artifact_revisions GROUP BY id \
                 ORDER BY MAX(updated_at_unix_ms) DESC LIMIT ?",
            )
            .bind(args.limit.unwrap_or(100).clamp(1, 200))
            .fetch_all(&self.pool)
            .await
            .map_err(internal_error)?
        };
        let repository = SqliteArtifactRepository::new(self.pool.clone());
        let mut artifacts = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(artifact) = repository.find(id).await.map_err(internal_error)? {
                artifacts.push(serde_json::to_value(artifact).map_err(internal_error)?);
            }
        }
        Ok(Value::Array(artifacts))
    }

    async fn open_preview(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: ArtifactIdArgs = parse(args)?;
        let lease = self
            .office
            .artifact_service()
            .open_preview(OpenPreview {
                artifact_id: args.artifact_id,
            })
            .await
            .map_err(internal_error)?;
        self.preview_proxy
            .register(
                lease.id,
                lease.loopback_port,
                &lease.capability_token,
                lease.expires_at_unix_ms,
            )
            .await
            .map_err(internal_error)?;
        Ok(json!({
            "leaseId": lease.id,
            "artifactId": lease.artifact_id,
            "providerId": lease.provider_id,
            "loopbackPort": lease.loopback_port,
            "capabilityToken": lease.capability_token,
            "expiresAtUnixMs": lease.expires_at_unix_ms,
            "docxFallbackSupported": lease.docx_fallback_supported,
        }))
    }

    async fn close_preview(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: LeaseIdArgs = parse(args)?;
        self.preview_proxy.revoke(args.lease_id).await;
        self.office
            .artifact_service()
            .close_preview(args.lease_id)
            .await
            .map_err(internal_error)?;
        Ok(Value::Null)
    }

    async fn automation_list(&self) -> Result<Value, ApplicationError> {
        let records = self
            .automation_store()
            .list()
            .await
            .map_err(internal_error)?;
        serialize(records.into_iter().map(automation_view).collect::<Vec<_>>())
    }

    async fn automation_create(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AutomationInputArgs = parse(args)?;
        let draft = self.normalize_draft(args.input).await?;
        let record = self
            .automation_store()
            .create(draft, Utc::now())
            .await
            .map_err(internal_error)?;
        serialize(automation_view(record))
    }

    async fn automation_update(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AutomationUpdateArgs = parse(args)?;
        let draft = self.normalize_draft(args.input).await?;
        let record = self
            .automation_store()
            .update(args.id, draft, Utc::now())
            .await
            .map_err(store_error)?;
        serialize(automation_view(record))
    }

    async fn automation_set_enabled(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AutomationEnabledArgs = parse(args)?;
        self.automation_store()
            .set_enabled(args.id, args.enabled, Utc::now())
            .await
            .map_err(store_error)?;
        Ok(Value::Null)
    }

    async fn automation_delete(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: IdArgs = parse(args)?;
        self.automation_store()
            .delete(args.id)
            .await
            .map_err(internal_error)?;
        Ok(Value::Null)
    }

    async fn automation_run_now(&self, args: Value) -> Result<Value, ApplicationError> {
        if !self.owns_automation_engine {
            return Err(ApplicationError::conflict(
                "this host does not own the Automation Engine lease",
            ));
        }
        let args: IdArgs = parse(args)?;
        let run = self
            .automation_store()
            .run_now(args.id, Utc::now())
            .await
            .map_err(store_error)?;
        let view = automation_run_view(run.clone());
        if run.snapshot.status == RunStatus::Running {
            let runtime = self.automation.clone();
            tokio::spawn(async move {
                runtime
                    .execute_claimed(ClaimedRun {
                        run_id: run.snapshot.run_id,
                        automation_id: run.snapshot.automation_id,
                        scheduled_for: run.started_at,
                        next_run_at: None,
                    })
                    .await;
            });
        }
        serialize(view)
    }

    async fn automation_cancel_run(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: RunIdArgs = parse(args)?;
        let store = self.automation_store();
        if !store
            .request_cancel(args.run_id)
            .await
            .map_err(internal_error)?
        {
            return Err(ApplicationError::conflict("automation run is not running"));
        }
        if let Some(run) = store.run(args.run_id).await.map_err(internal_error)?
            && let Some(conversation_id) = run.snapshot.conversation_id
        {
            ConversationSessionService::new(self.conversations.clone())
                .cancel_turn(
                    conversation_id,
                    Some("automation run cancelled".to_string()),
                )
                .await
                .map_err(internal_error)?;
        }
        self.automation
            .reconcile_running_turns()
            .await
            .map_err(ApplicationError::internal)?;
        Ok(Value::Null)
    }

    async fn automation_runs(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AutomationRunsArgs = parse(args)?;
        let runs = self
            .automation_store()
            .runs(args.automation_id, args.limit.unwrap_or(20))
            .await
            .map_err(internal_error)?;
        serialize(
            runs.into_iter()
                .map(automation_run_view)
                .collect::<Vec<_>>(),
        )
    }

    fn automation_preview(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: PreviewRunsArgs = parse(args)?;
        let values = ScheduleService::new(SystemClock)
            .preview(
                &ScheduleSpec::Schedule {
                    cron: args.cron,
                    timezone: args.timezone,
                },
                args.count.unwrap_or(5),
            )
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        serialize(values)
    }

    fn automation_templates(&self) -> Result<Value, ApplicationError> {
        serialize(
            BuiltinTemplateCatalog::all()
                .into_iter()
                .map(|template| json!({ "id": template.id, "draft": template.draft }))
                .collect::<Vec<_>>(),
        )
    }

    async fn automation_unseen_failures(&self) -> Result<Value, ApplicationError> {
        Ok(json!(
            self.automation_store()
                .unseen_failure_count()
                .await
                .map_err(internal_error)?
        ))
    }

    async fn automation_mark_seen(&self) -> Result<Value, ApplicationError> {
        self.automation_store()
            .mark_all_seen()
            .await
            .map_err(internal_error)?;
        Ok(Value::Null)
    }

    async fn delegation_cancel(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: DelegationCancelArgs = parse(args)?;
        ConversationSessionService::new(self.conversations.clone())
            .cancel_turn(
                args.child_conversation_id,
                Some("delegation cancelled remotely".to_string()),
            )
            .await
            .map_err(internal_error)?;
        Ok(Value::Null)
    }

    async fn normalize_draft(
        &self,
        input: AutomationDraftRequest,
    ) -> Result<AutomationDraft, ApplicationError> {
        let mut launch = input.launch.0;
        launch.workspace.root_folder =
            ProjectRepo::find_repos_for_project(&self.pool, launch.workspace.project_id)
                .await
                .map_err(internal_error)?
                .into_iter()
                .next()
                .map(|repo| repo.path.to_string_lossy().to_string())
                .ok_or_else(|| ApplicationError::bad_request("project has no repository"))?;
        launch.workspace.branch = launch
            .workspace
            .branch
            .map(|branch| branch.trim().to_string())
            .filter(|branch| !branch.is_empty());
        let draft = AutomationDraft {
            name: input.name,
            enabled: input.enabled,
            trigger: input.trigger,
            launch: AutomationDraftInput(launch),
        };
        TurnLaunchSpec::from_automation_draft(draft.launch.clone())
            .and_then(|spec| {
                spec.validate_plugin_actions(&OfficeActionCatalog {
                    manifest: self.office.bundled_plugin(),
                })
            })
            .map_err(|error| ApplicationError::bad_request(format!("{}: {error}", error.code())))?;
        Ok(draft)
    }
}

#[async_trait]
impl ApplicationDomainPort for ServerApplicationDomains {
    async fn execute(
        &self,
        _principal: &Principal,
        command: DomainCommand,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        self.execute_command(command, args).await
    }
}

struct OfficeActionCatalog<'a> {
    manifest: &'a plugins::PluginManifest,
}

impl PluginActionCatalogPort for OfficeActionCatalog<'_> {
    fn contains(&self, reference: &automation::PluginActionRef) -> bool {
        reference.plugin_id == self.manifest.id
            && self
                .manifest
                .actions
                .iter()
                .any(|action| action.id == reference.action.id)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskArgs {
    task_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnableOfficeArgs {
    enabled: bool,
    task_id: String,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactListArgs {
    conversation_id: Option<Uuid>,
    limit: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactIdArgs {
    artifact_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LeaseIdArgs {
    lease_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutomationDraftRequest {
    name: String,
    enabled: bool,
    trigger: ScheduleSpec,
    launch: AutomationDraftInput,
}

#[derive(Deserialize)]
struct AutomationInputArgs {
    input: AutomationDraftRequest,
}

#[derive(Deserialize)]
struct AutomationUpdateArgs {
    id: Uuid,
    input: AutomationDraftRequest,
}

#[derive(Deserialize)]
struct AutomationEnabledArgs {
    id: Uuid,
    enabled: bool,
}

#[derive(Deserialize)]
struct IdArgs {
    id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepoIdArgs {
    repo_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentIdArgs {
    agent_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunIdArgs {
    run_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutomationRunsArgs {
    automation_id: Uuid,
    limit: Option<i64>,
}

#[derive(Deserialize)]
struct PreviewRunsArgs {
    cron: String,
    timezone: String,
    count: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DelegationCancelArgs {
    child_conversation_id: Uuid,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AutomationView {
    id: Uuid,
    name: String,
    enabled: bool,
    spec_version: u16,
    trigger: ScheduleSpec,
    next_run_at: Option<DateTime<Utc>>,
    launch: TurnLaunchSpec,
    migration_required: bool,
    unseen_failure_count: i64,
    last_run_status: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AutomationRunView {
    id: Uuid,
    automation_id: Uuid,
    trigger: String,
    scheduled_for: Option<DateTime<Utc>>,
    status: &'static str,
    cancellation_requested: bool,
    conversation_id: Option<Uuid>,
    turn_id: Option<Uuid>,
    workspace_id: Option<Uuid>,
    stop_reason: Option<String>,
    summary: Option<String>,
    error: Option<String>,
    seen: bool,
    started_at: DateTime<Utc>,
    finished_at: Option<DateTime<Utc>>,
}

fn automation_view(record: AutomationRecord) -> AutomationView {
    AutomationView {
        id: record.id,
        name: record.name,
        enabled: record.enabled,
        spec_version: record.spec_version,
        trigger: record.trigger,
        next_run_at: record.next_run_at,
        launch: record.launch_spec,
        migration_required: record.legacy_migration_status == "migration_required",
        unseen_failure_count: record.unseen_failure_count,
        last_run_status: record.last_run_status,
        created_at: record.created_at,
        updated_at: record.updated_at,
    }
}

fn automation_run_view(run: AutomationRunRecord) -> AutomationRunView {
    AutomationRunView {
        id: run.snapshot.run_id,
        automation_id: run.snapshot.automation_id,
        trigger: run.trigger,
        scheduled_for: run.scheduled_for,
        status: match run.snapshot.status {
            RunStatus::Running => "running",
            RunStatus::Completed => "completed",
            RunStatus::Failed => "failed",
            RunStatus::Cancelled => "cancelled",
            RunStatus::Interrupted => "interrupted",
            RunStatus::Skipped => "skipped",
        },
        cancellation_requested: run.snapshot.cancellation_requested,
        conversation_id: run.snapshot.conversation_id,
        turn_id: run.snapshot.turn_id,
        workspace_id: run.snapshot.workspace_id,
        stop_reason: run.stop_reason,
        summary: run.summary,
        error: run.snapshot.error,
        seen: run.seen,
        started_at: run.started_at,
        finished_at: run.finished_at,
    }
}

fn dependency_json(id: &str, state: &DependencyState) -> Value {
    match state {
        DependencyState::Missing => component_json(id, "missing", None, None),
        DependencyState::Installing => component_json(id, "installing", None, None),
        DependencyState::Ready { version, .. } => component_json(id, "ready", Some(version), None),
        DependencyState::Failed { message, .. } => {
            component_json(id, "failed", None, Some(message))
        }
        DependencyState::Incompatible { message, .. } => {
            component_json(id, "incompatible", None, Some(message))
        }
    }
}

fn skill_json(id: &str, state: &SkillState) -> Value {
    match state {
        SkillState::Missing => component_json(id, "missing", None, None),
        SkillState::Ready => component_json(id, "ready", None, None),
        SkillState::Failed { message, .. } => component_json(id, "failed", None, Some(message)),
    }
}

fn provider_json(id: &str, state: &ProviderState) -> Value {
    match state {
        ProviderState::Unavailable => component_json(id, "unavailable", None, None),
        ProviderState::Ready => component_json(id, "ready", None, None),
        ProviderState::Degraded { message, .. } => {
            component_json(id, "degraded", None, Some(message))
        }
    }
}

fn component_json(
    id: &str,
    status: &str,
    version: Option<&String>,
    error: Option<&String>,
) -> Value {
    json!({ "id": id, "status": status, "version": version, "error": error })
}

fn parse<T: DeserializeOwned>(value: Value) -> Result<T, ApplicationError> {
    serde_json::from_value(value).map_err(|error| ApplicationError::bad_request(error.to_string()))
}

fn serialize(value: impl Serialize) -> Result<Value, ApplicationError> {
    serde_json::to_value(value).map_err(internal_error)
}

fn require_nonempty(value: &str, name: &str) -> Result<(), ApplicationError> {
    if value.trim().is_empty() {
        Err(ApplicationError::bad_request(format!(
            "{name} must not be empty"
        )))
    } else {
        Ok(())
    }
}

fn internal_error(error: impl std::fmt::Display) -> ApplicationError {
    ApplicationError::internal(error.to_string())
}

fn store_error(error: sqlx::Error) -> ApplicationError {
    match error {
        sqlx::Error::RowNotFound => ApplicationError::not_found("record not found"),
        other => internal_error(other),
    }
}

fn capability_catalog_fingerprint(launch_lock: &SessionLaunchLock) -> String {
    let mut digest = Sha256::new();
    digest.update(b"open-agent-capability-catalog-v1:");
    digest.update(launch_lock.agent_id.as_str().as_bytes());
    digest.update(b"\0");
    digest.update(
        launch_lock
            .absolute_acp_program
            .to_string_lossy()
            .as_bytes(),
    );
    for argument in &launch_lock.args {
        digest.update(b"\0arg:");
        digest.update(argument.as_bytes());
    }
    for (key, value) in &launch_lock.env {
        digest.update(b"\0env:");
        digest.update(key.as_bytes());
        digest.update(b"=");
        digest.update(value.as_bytes());
    }
    digest.update(b"\0runtime:");
    digest.update(launch_lock.runtime_version.as_bytes());
    digest.update(b"\0acp:");
    digest.update(launch_lock.acp_version.as_bytes());
    format!("{:x}", digest.finalize())
}
