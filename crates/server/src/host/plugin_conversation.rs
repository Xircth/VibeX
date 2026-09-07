use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, OnceLock},
};

use application::{
    ApplicationCore, ApplicationError, CancelConversationInputRequest, CancelConversationTurn,
    ConversationOutputView, CreateConversation, ListConversationInputsRequest, Principal,
    RespondConversationPermission, RespondConversationQuestion, SqliteConversationRepository,
    SteerConversationTurnRequest, SubmitConversationInputRequest,
};
use async_trait::async_trait;
use conversations::ConversationProjector;
use db::models::{
    conversation::DbConversationSummary,
    project::{CreateProject, Project},
    project_repo::ProjectRepo,
    repo::Repo,
    task::{CreateTask, Task},
    workspace::{CreateWorkspace, Workspace},
    workspace_repo::{CreateWorkspaceRepo, WorkspaceRepo},
};
use plugins::{
    PluginConversationCancelInput, PluginConversationCreate, PluginConversationEnqueue,
    PluginConversationError, PluginConversationErrorCode, PluginConversationEventPage,
    PluginConversationHost, PluginConversationInputReceipt, PluginConversationPermission,
    PluginConversationQuestion, PluginConversationSteer, PluginConversationSummary,
    PluginConversationTurn, PluginConversationView,
};
use remote_protocol::ErrorCode;
use serde_json::json;
use sqlx::SqlitePool;
use uuid::Uuid;

pub struct HostPluginConversationHost {
    pool: SqlitePool,
    scratch_root: PathBuf,
    core: OnceLock<Arc<ApplicationCore<SqliteConversationRepository>>>,
}

impl HostPluginConversationHost {
    pub fn new(pool: SqlitePool, scratch_root: PathBuf) -> Self {
        Self {
            pool,
            scratch_root,
            core: OnceLock::new(),
        }
    }

    pub fn attach_core(&self, core: Arc<ApplicationCore<SqliteConversationRepository>>) {
        let _ = self.core.set(core);
    }

    fn core(
        &self,
    ) -> Result<&ApplicationCore<SqliteConversationRepository>, PluginConversationError> {
        self.core.get().map(Arc::as_ref).ok_or_else(|| {
            PluginConversationError::new(
                PluginConversationErrorCode::Unavailable,
                "Conversation core is not attached",
            )
        })
    }

    async fn require_bound(
        &self,
        plugin_id: &str,
        conversation_id: Uuid,
    ) -> Result<(), PluginConversationError> {
        let bound = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM plugin_conversation_bindings
             WHERE plugin_id = ? AND conversation_id = ?",
        )
        .bind(plugin_id)
        .bind(conversation_id)
        .fetch_one(&self.pool)
        .await
        .map_err(store_failed)?;
        if bound == 0 {
            return Err(PluginConversationError::new(
                PluginConversationErrorCode::ScopeDenied,
                "No conversation is bound to this plugin",
            ));
        }
        Ok(())
    }

    async fn bind(
        &self,
        plugin_id: &str,
        conversation_id: Uuid,
    ) -> Result<(), PluginConversationError> {
        sqlx::query(
            "INSERT OR IGNORE INTO plugin_conversation_bindings (plugin_id, conversation_id)
             VALUES (?, ?)",
        )
        .bind(plugin_id)
        .bind(conversation_id)
        .execute(&self.pool)
        .await
        .map_err(store_failed)?;
        Ok(())
    }

    async fn bound_ids(&self, plugin_id: &str) -> Result<Vec<Uuid>, PluginConversationError> {
        sqlx::query_scalar::<_, Uuid>(
            "SELECT conversation_id FROM plugin_conversation_bindings
             WHERE plugin_id = ?
             ORDER BY created_at DESC",
        )
        .bind(plugin_id)
        .fetch_all(&self.pool)
        .await
        .map_err(store_failed)
    }

    async fn bound_summary(
        &self,
        plugin_id: &str,
        conversation_id: Uuid,
    ) -> Result<DbConversationSummary, PluginConversationError> {
        self.require_bound(plugin_id, conversation_id).await?;
        DbConversationSummary::find_by_id(&self.pool, conversation_id)
            .await
            .map_err(store_failed)?
            .ok_or_else(|| {
                PluginConversationError::new(
                    PluginConversationErrorCode::NotFound,
                    format!("conversation {conversation_id} was not found"),
                )
            })
    }

    async fn view_for(
        &self,
        summary: DbConversationSummary,
    ) -> Result<PluginConversationView, PluginConversationError> {
        let output = self
            .core()?
            .conversation_output(&Principal::local_desktop(), summary.id)
            .await
            .map_err(map_application)?;
        let inputs = self
            .core()?
            .list_conversation_inputs(
                &Principal::local_desktop(),
                ListConversationInputsRequest {
                    conversation_id: summary.id,
                },
            )
            .await
            .ok();
        let mut view = view_from(summary, output);
        if let Some(inputs) = inputs {
            view.inputs = Some(serde_json::to_value(inputs).map_err(|error| {
                PluginConversationError::new(PluginConversationErrorCode::Failed, error.to_string())
            })?);
        }
        Ok(view)
    }

    async fn resolve_workspace_id(
        &self,
        plugin_id: &str,
        workspace_id: Option<&str>,
    ) -> Result<Uuid, PluginConversationError> {
        match workspace_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            Some(id) => parse_uuid(id, "workspaceId"),
            None => self.ensure_scratch_workspace(plugin_id).await,
        }
    }

    async fn ensure_scratch_workspace(
        &self,
        plugin_id: &str,
    ) -> Result<Uuid, PluginConversationError> {
        if let Some(existing) = sqlx::query_scalar::<_, Uuid>(
            "SELECT workspace_id FROM plugin_scratch_workspaces WHERE plugin_id = ?",
        )
        .bind(plugin_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(store_failed)?
            && Workspace::find_by_id(&self.pool, existing)
                .await
                .map_err(store_failed)?
                .is_some()
        {
            return Ok(existing);
        }

        let root = self.scratch_root.join(plugin_id);
        ensure_git_repo(&root)?;
        let root_str = root.to_string_lossy().into_owned();
        let project_id = Uuid::new_v4();
        let workspace_id = Uuid::new_v4();
        let task_id = Uuid::new_v4();
        Project::create(
            &self.pool,
            &CreateProject {
                name: format!("plugin:{plugin_id}"),
                repositories: Vec::new(),
            },
            project_id,
        )
        .await
        .map_err(store_failed)?;
        let repo =
            match ProjectRepo::add_repo_to_project(&self.pool, project_id, &root_str, plugin_id)
                .await
            {
                Ok(repo) => repo,
                Err(_) => Repo::find_or_create(&self.pool, &root, plugin_id)
                    .await
                    .map_err(store_failed)?,
            };
        Task::create(
            &self.pool,
            &CreateTask::from_title_description(project_id, plugin_id.to_owned(), None),
            task_id,
        )
        .await
        .map_err(store_failed)?;
        Workspace::create(
            &self.pool,
            &CreateWorkspace {
                project_id,
                parent_workspace_id: None,
                branch: "main".into(),
                container_ref: Some(root_str.clone()),
                use_worktree: false,
                agent_working_dir: Some(root_str),
            },
            workspace_id,
            task_id,
        )
        .await
        .map_err(|error| {
            PluginConversationError::new(PluginConversationErrorCode::Failed, error.to_string())
        })?;
        WorkspaceRepo::create_many(
            &self.pool,
            workspace_id,
            &[CreateWorkspaceRepo {
                repo_id: repo.id,
                target_branch: "main".into(),
            }],
        )
        .await
        .map_err(store_failed)?;
        sqlx::query(
            "INSERT OR REPLACE INTO plugin_scratch_workspaces (plugin_id, project_id, workspace_id)
             VALUES (?, ?, ?)",
        )
        .bind(plugin_id)
        .bind(project_id)
        .bind(workspace_id)
        .execute(&self.pool)
        .await
        .map_err(store_failed)?;
        Ok(workspace_id)
    }
}

#[async_trait]
impl PluginConversationHost for HostPluginConversationHost {
    async fn create(
        &self,
        plugin_id: &str,
        request: PluginConversationCreate,
    ) -> Result<PluginConversationView, PluginConversationError> {
        let workspace_id = self
            .resolve_workspace_id(plugin_id, request.workspace_id.as_deref())
            .await?;
        let prompt = request
            .prompt
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        let summary = self
            .core()?
            .create_conversation(
                &Principal::local_desktop(),
                CreateConversation {
                    workspace_id,
                    agent_id: request.agent_id.clone(),
                    title: request.title.clone(),
                    initial_prompt: prompt.clone(),
                },
            )
            .await
            .map_err(map_application)?;
        self.bind(plugin_id, summary.id).await?;
        if let Some(text) = prompt {
            let _ = self
                .enqueue(
                    plugin_id,
                    PluginConversationEnqueue {
                        conversation_id: summary.id.to_string(),
                        text,
                        images: Vec::new(),
                        mode_override: None,
                    },
                )
                .await?;
        }
        let summary = DbConversationSummary::find_by_id(&self.pool, summary.id)
            .await
            .map_err(store_failed)?
            .ok_or_else(|| {
                PluginConversationError::new(
                    PluginConversationErrorCode::NotFound,
                    "conversation was not created",
                )
            })?;
        self.view_for(summary).await
    }

    async fn list(
        &self,
        plugin_id: &str,
    ) -> Result<Vec<PluginConversationSummary>, PluginConversationError> {
        let mut summaries = Vec::new();
        for id in self.bound_ids(plugin_id).await? {
            if let Some(summary) = DbConversationSummary::find_by_id(&self.pool, id)
                .await
                .map_err(store_failed)?
            {
                summaries.push(summary_from(&summary));
            }
        }
        Ok(summaries)
    }

    async fn get(
        &self,
        plugin_id: &str,
        conversation_id: &str,
    ) -> Result<PluginConversationView, PluginConversationError> {
        let conversation_id = parse_uuid(conversation_id, "conversationId")?;
        let summary = self.bound_summary(plugin_id, conversation_id).await?;
        self.view_for(summary).await
    }

    async fn enqueue(
        &self,
        plugin_id: &str,
        request: PluginConversationEnqueue,
    ) -> Result<PluginConversationInputReceipt, PluginConversationError> {
        let conversation_id = parse_uuid(&request.conversation_id, "conversationId")?;
        let summary = self.bound_summary(plugin_id, conversation_id).await?;
        let agent_id = summary.agent_id.clone().ok_or_else(|| {
            PluginConversationError::new(
                PluginConversationErrorCode::Invalid,
                "conversation has no agent",
            )
        })?;
        let submission = self
            .core()?
            .submit_conversation_input(
                &Principal::local_desktop(),
                Uuid::new_v4(),
                SubmitConversationInputRequest {
                    conversation_id,
                    payload: agents::ConversationInputPayload {
                        agent_id,
                        workspace_id: summary.workspace_id,
                        executor_profile_id: None,
                        text: request.text,
                        display_text: None,
                        images: request.images,
                        mode_override: request.mode_override,
                        config_overrides: Vec::new(),
                        workflow_refs: Vec::new(),
                        file_refs: Vec::new(),
                    },
                },
            )
            .await
            .map_err(map_application)?;
        Ok(PluginConversationInputReceipt {
            input_id: submission.input.id.to_string(),
            conversation_id: conversation_id.to_string(),
            turn_id: submission.turn.map(|turn| turn.turn_id.to_string()),
        })
    }

    async fn steer(
        &self,
        plugin_id: &str,
        request: PluginConversationSteer,
    ) -> Result<serde_json::Value, PluginConversationError> {
        let conversation_id = parse_uuid(&request.conversation_id, "conversationId")?;
        self.require_bound(plugin_id, conversation_id).await?;
        let expected_turn_id = parse_uuid(&request.expected_turn_id, "expectedTurnId")?;
        let receipt = self
            .core()?
            .steer_conversation_turn(
                &Principal::local_desktop(),
                Uuid::new_v4(),
                SteerConversationTurnRequest {
                    conversation_id,
                    expected_turn_id,
                    text: request.text,
                    images: request.images,
                },
            )
            .await
            .map_err(map_application)?;
        serde_json::to_value(receipt).map_err(|error| {
            PluginConversationError::new(PluginConversationErrorCode::Failed, error.to_string())
        })
    }

    async fn cancel(
        &self,
        plugin_id: &str,
        conversation_id: &str,
    ) -> Result<(), PluginConversationError> {
        let conversation_id = parse_uuid(conversation_id, "conversationId")?;
        self.require_bound(plugin_id, conversation_id).await?;
        self.core()?
            .cancel_conversation_turn(
                &Principal::local_desktop(),
                CancelConversationTurn {
                    conversation_id,
                    reason: None,
                },
            )
            .await
            .map_err(map_application)
    }

    async fn cancel_input(
        &self,
        plugin_id: &str,
        request: PluginConversationCancelInput,
    ) -> Result<serde_json::Value, PluginConversationError> {
        let conversation_id = parse_uuid(&request.conversation_id, "conversationId")?;
        self.require_bound(plugin_id, conversation_id).await?;
        let input_id = parse_uuid(&request.input_id, "inputId")?;
        let view = self
            .core()?
            .cancel_conversation_input(
                &Principal::local_desktop(),
                Uuid::new_v4(),
                CancelConversationInputRequest {
                    conversation_id,
                    input_id,
                    expected_revision: request.expected_revision,
                },
            )
            .await
            .map_err(map_application)?;
        serde_json::to_value(view).map_err(|error| {
            PluginConversationError::new(PluginConversationErrorCode::Failed, error.to_string())
        })
    }

    async fn list_inputs(
        &self,
        plugin_id: &str,
        conversation_id: &str,
    ) -> Result<serde_json::Value, PluginConversationError> {
        let conversation_id = parse_uuid(conversation_id, "conversationId")?;
        self.require_bound(plugin_id, conversation_id).await?;
        let inputs = self
            .core()?
            .list_conversation_inputs(
                &Principal::local_desktop(),
                ListConversationInputsRequest { conversation_id },
            )
            .await
            .map_err(map_application)?;
        Ok(json!({ "inputs": inputs }))
    }

    async fn respond_permission(
        &self,
        plugin_id: &str,
        request: PluginConversationPermission,
    ) -> Result<(), PluginConversationError> {
        let conversation_id = parse_uuid(&request.conversation_id, "conversationId")?;
        self.require_bound(plugin_id, conversation_id).await?;
        self.core()?
            .respond_conversation_permission(
                &Principal::local_desktop(),
                RespondConversationPermission {
                    conversation_id,
                    permission_id: request.permission_id,
                    response: request.response,
                },
            )
            .await
            .map_err(map_application)
    }

    async fn respond_question(
        &self,
        plugin_id: &str,
        request: PluginConversationQuestion,
    ) -> Result<(), PluginConversationError> {
        let conversation_id = parse_uuid(&request.conversation_id, "conversationId")?;
        self.require_bound(plugin_id, conversation_id).await?;
        self.core()?
            .respond_conversation_question(
                &Principal::local_desktop(),
                RespondConversationQuestion {
                    conversation_id,
                    question_id: request.question_id,
                    response: request.response,
                },
            )
            .await
            .map_err(map_application)
    }

    async fn set_mode(
        &self,
        plugin_id: &str,
        conversation_id: &str,
        mode_id: &str,
    ) -> Result<(), PluginConversationError> {
        let conversation_id = parse_uuid(conversation_id, "conversationId")?;
        self.require_bound(plugin_id, conversation_id).await?;
        self.core()?
            .set_session_mode(
                &Principal::local_desktop(),
                conversation_id,
                mode_id.to_owned(),
            )
            .await
            .map_err(map_application)
    }

    async fn set_config_option(
        &self,
        plugin_id: &str,
        conversation_id: &str,
        key: &str,
        value: serde_json::Value,
    ) -> Result<(), PluginConversationError> {
        let conversation_id = parse_uuid(conversation_id, "conversationId")?;
        self.require_bound(plugin_id, conversation_id).await?;
        self.core()?
            .set_session_config_option(
                &Principal::local_desktop(),
                conversation_id,
                key.to_owned(),
                value,
            )
            .await
            .map_err(map_application)
    }

    async fn events_since(
        &self,
        plugin_id: &str,
        conversation_id: &str,
        after_sequence: i64,
    ) -> Result<PluginConversationEventPage, PluginConversationError> {
        let conversation_id = parse_uuid(conversation_id, "conversationId")?;
        self.require_bound(plugin_id, conversation_id).await?;
        let (rows, last_sequence) =
            ConversationProjector::rows_since(&self.pool, conversation_id, after_sequence)
                .await
                .map_err(store_failed)?;
        Ok(PluginConversationEventPage {
            conversation_id: conversation_id.to_string(),
            after_sequence,
            last_sequence,
            rows: serde_json::to_value(rows).map_err(|error| {
                PluginConversationError::new(PluginConversationErrorCode::Failed, error.to_string())
            })?,
        })
    }

    async fn catalog(
        &self,
        _plugin_id: &str,
    ) -> Result<serde_json::Value, PluginConversationError> {
        let catalog = self
            .core()?
            .conversation_catalog(&Principal::local_desktop())
            .await
            .map_err(map_application)?;
        Ok(json!({ "agents": catalog.agents }))
    }

    async fn archive(
        &self,
        plugin_id: &str,
        conversation_id: &str,
    ) -> Result<(), PluginConversationError> {
        let conversation_id = parse_uuid(conversation_id, "conversationId")?;
        self.require_bound(plugin_id, conversation_id).await?;
        self.core()?
            .set_conversation_status(
                &Principal::local_desktop(),
                conversation_id,
                "archived".into(),
            )
            .await
            .map_err(map_application)
    }

    async fn grant(
        &self,
        plugin_id: &str,
        conversation_id: &str,
    ) -> Result<(), PluginConversationError> {
        let conversation_id = parse_uuid(conversation_id, "conversationId")?;
        let exists = DbConversationSummary::find_by_id(&self.pool, conversation_id)
            .await
            .map_err(store_failed)?;
        if exists.is_none() {
            return Err(PluginConversationError::new(
                PluginConversationErrorCode::NotFound,
                format!("conversation {conversation_id} was not found"),
            ));
        }
        self.bind(plugin_id, conversation_id).await
    }
}

fn summary_from(summary: &DbConversationSummary) -> PluginConversationSummary {
    PluginConversationSummary {
        id: summary.id.to_string(),
        workspace_id: summary.workspace_id.to_string(),
        agent_id: summary.agent_id.as_ref().map(|id| id.as_str().to_owned()),
        title: summary.title.clone(),
        status: summary.status.to_string(),
    }
}

fn view_from(
    summary: DbConversationSummary,
    output: ConversationOutputView,
) -> PluginConversationView {
    PluginConversationView {
        summary: summary_from(&summary),
        sequence: output
            .turn
            .as_ref()
            .map(|turn| turn.last_sequence)
            .unwrap_or(0),
        turn: output.turn.map(|turn| PluginConversationTurn {
            turn_id: turn.turn_id.to_string(),
            status: turn.status,
            last_sequence: turn.last_sequence,
        }),
        assistant_text: output.assistant_text,
        inputs: None,
    }
}

fn ensure_git_repo(dir: &Path) -> Result<(), PluginConversationError> {
    std::fs::create_dir_all(dir).map_err(store_failed)?;
    if dir.join(".git").exists() {
        return Ok(());
    }
    let status = Command::new("git")
        .arg("init")
        .current_dir(dir)
        .status()
        .map_err(store_failed)?;
    if !status.success() {
        return Err(PluginConversationError::new(
            PluginConversationErrorCode::Failed,
            "git init failed for the plugin scratch workspace",
        ));
    }
    Ok(())
}

fn parse_uuid(value: &str, field: &str) -> Result<Uuid, PluginConversationError> {
    Uuid::parse_str(value.trim()).map_err(|_| {
        PluginConversationError::new(
            PluginConversationErrorCode::Invalid,
            format!("{field} is not a UUID"),
        )
    })
}

fn store_failed(error: impl std::fmt::Display) -> PluginConversationError {
    PluginConversationError::new(PluginConversationErrorCode::Failed, error.to_string())
}

fn map_application(error: ApplicationError) -> PluginConversationError {
    let envelope = error.envelope();
    let code = match envelope.code {
        ErrorCode::NotFound => PluginConversationErrorCode::NotFound,
        ErrorCode::Forbidden | ErrorCode::Unauthorized => PluginConversationErrorCode::ScopeDenied,
        ErrorCode::BadRequest | ErrorCode::Conflict => PluginConversationErrorCode::Invalid,
        ErrorCode::CapabilityUnavailable => PluginConversationErrorCode::Unavailable,
        ErrorCode::Internal => PluginConversationErrorCode::Failed,
        _ => PluginConversationErrorCode::Failed,
    };
    PluginConversationError::new(code, envelope.message.clone())
}
