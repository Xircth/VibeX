use super::*;

impl ServerApplicationDomains {
    pub(super) async fn project_list(&self) -> Result<Value, ApplicationError> {
        let _ = self
            .deployment
            .project()
            .migrate_multi_repo_projects(&self.pool, self.deployment.repo())
            .await;
        let _ = self
            .deployment
            .project()
            .ensure_home_project(&self.pool, self.deployment.repo())
            .await;
        serialize(
            Project::find_all(&self.pool)
                .await
                .map_err(internal_error)?,
        )
    }

    pub(crate) async fn conversation_projects(&self) -> Result<Value, ApplicationError> {
        #[derive(Debug, Serialize)]
        #[serde(rename_all = "camelCase")]
        struct ProjectSummary {
            id: Uuid,
            name: String,
            root_path: String,
            parent_project_id: Option<Uuid>,
            is_git: bool,
            is_home: bool,
            workspace_ids: Vec<Uuid>,
        }

        let _ = self
            .deployment
            .project()
            .migrate_multi_repo_projects(&self.pool, self.deployment.repo())
            .await;
        let _ = self
            .deployment
            .project()
            .ensure_home_project(&self.pool, self.deployment.repo())
            .await;
        let projects = Project::find_all(&self.pool)
            .await
            .map_err(internal_error)?;
        for project in &projects {
            let _ = self.ensure_root_workspace(project.id, None).await;
        }
        let rows = sqlx::query_as::<_, (Uuid, Uuid)>(
            r#"SELECT project_id, id
               FROM workspaces
               WHERE project_id IS NOT NULL
               ORDER BY use_worktree ASC, created_at DESC"#,
        )
        .fetch_all(&self.pool)
        .await
        .map_err(internal_error)?;
        let mut by_project: std::collections::HashMap<Uuid, Vec<Uuid>> =
            std::collections::HashMap::new();
        for (project_id, workspace_id) in rows {
            by_project.entry(project_id).or_default().push(workspace_id);
        }
        let summaries: Vec<ProjectSummary> = projects
            .into_iter()
            .map(|project| ProjectSummary {
                workspace_ids: by_project.remove(&project.id).unwrap_or_default(),
                id: project.id,
                name: project.name,
                root_path: project.root_path,
                parent_project_id: project.parent_project_id,
                is_git: project.is_git,
                is_home: project.is_home,
            })
            .collect();
        serialize(summaries)
    }

    pub(crate) async fn workspace_has_repositories(
        &self,
        workspace_id: Uuid,
    ) -> Result<bool, ApplicationError> {
        let repositories = db::models::workspace_repo::WorkspaceRepo::find_repos_for_workspace(
            &self.pool,
            workspace_id,
        )
        .await
        .map_err(internal_error)?;
        Ok(!repositories.is_empty())
    }

    pub(super) async fn project_repositories(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: IdArgs = parse(args)?;
        serialize(
            ProjectRepo::find_repos_for_project(&self.pool, args.id)
                .await
                .map_err(internal_error)?,
        )
    }

    pub(super) async fn repo_branches(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: RepoIdArgs = parse(args)?;
        let repo = self
            .deployment
            .repo()
            .get_by_id(&self.pool, args.repo_id)
            .await
            .map_err(internal_error)?;
        let git = self.deployment.git().clone();
        let repo_path = repo.path.clone();
        let branches = tokio::task::spawn_blocking(move || git.get_all_branches(&repo_path))
            .await
            .map_err(|error| ApplicationError::internal(error.to_string()))?
            .map_err(internal_error)?;
        serialize(branches)
    }

    pub(super) async fn agent_management_bar(&self) -> Result<Value, ApplicationError> {
        let mut views =
            services::services::agent_management::AgentManagementApplicationService::new(
                self.pool.clone(),
            )
            .list()
            .await
            .map_err(internal_error)?;
        services::services::agent_management_runtime::overlay_local_runtime_evidence(
            &self.agent_management_runtime,
            &mut views,
        )
        .await;
        serialize(views)
    }

    pub(crate) async fn agent_capability_catalog(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let args: AgentIdArgs = parse(args)?;
        let agent_id = AgentId::parse(args.agent_id).map_err(internal_error)?;
        serialize(
            conversations::read_matching_capability_catalog_for_defaults_for_provider_instance(
                &self.pool,
                &agent_id,
                args.provider_instance_id.as_deref(),
            )
            .await
            .map_err(conversation_error)?,
        )
    }

    pub(super) async fn agent_capability_catalog_fresh(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AgentIdArgs = parse(args)?;
        let agent_id = AgentId::parse(args.agent_id).map_err(internal_error)?;
        serialize(
            conversations::capability_catalog_is_fresh_for_provider_instance(
                &self.pool,
                &agent_id,
                args.provider_instance_id.as_deref(),
            )
            .await
            .map_err(conversation_error)?,
        )
    }

    pub(super) async fn agent_refresh_capability_catalog(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let args: AgentIdArgs = parse(args)?;
        let agent_id = AgentId::parse(args.agent_id).map_err(internal_error)?;
        serialize(
            conversations::refresh_open_capability_catalog_for_provider_instance(
                &self.pool,
                &self.conversations.agent_runtime,
                &agent_id,
                args.provider_instance_id.as_deref(),
            )
            .await
            .map_err(conversation_error)?,
        )
    }

    pub(super) async fn agent_skills(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AgentSkillsArgs = parse(args)?;
        crate::host::catalog::skills::list_agent_skills(self, args.agent_type, args.workspace_path)
            .await
    }

    pub(super) async fn user_system_info(&self) -> Result<Value, ApplicationError> {
        let mut value = crate::host::catalog::config::user_system_info(self).await?;
        if let (Some(object), Ok(catalog)) =
            (value.as_object_mut(), self.plugin_control_catalog().await)
            && let Some(plugins) = catalog.get("plugins").cloned()
        {
            object.insert("plugins".to_string(), plugins);
        }
        Ok(value)
    }

    pub(super) async fn artifact_list(&self, args: Value) -> Result<Value, ApplicationError> {
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

    pub(super) async fn open_preview(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: ArtifactIdArgs = parse(args)?;
        let artifact = SqliteArtifactRepository::new(self.pool.clone())
            .find(args.artifact_id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| ApplicationError::not_found(format!("artifact {}", args.artifact_id)))?;
        let file_path = tokio::fs::canonicalize(artifact.scope_root.join(&artifact.relative_path))
            .await
            .map_err(internal_error)?;
        let provider_id = artifact.producer.provider_id.clone();
        let lease = plugins::PluginArtifactPreviewService::new(
            self.plugin_control_plane.clone(),
            self.capability_broker.clone(),
        )
        .open(plugins::PluginPreviewRequest {
            file_path: file_path.to_string_lossy().into_owned(),
            media_type: artifact.media_type,
            plugin_id: artifact.producer.plugin_id,
            plugin_version: artifact.producer.plugin_version,
            provider_id: provider_id.clone(),
            generation: 0,
            package_digest: String::new(),
        })
        .await
        .map_err(internal_error)?;
        let lease_id = Uuid::parse_str(&lease.lease_id).map_err(internal_error)?;
        self.preview_proxy
            .register(
                lease_id,
                lease.loopback_port,
                &lease.capability_token,
                lease.expires_at_unix_ms,
            )
            .await
            .map_err(internal_error)?;
        let preview_url = self
            .preview_proxy
            .preview_url(lease_id, &lease.capability_token)
            .await;
        Ok(json!({
            "leaseId": lease_id,
            "artifactId": args.artifact_id,
            "providerId": provider_id,
            "loopbackPort": lease.loopback_port,
            "capabilityToken": lease.capability_token,
            "expiresAtUnixMs": lease.expires_at_unix_ms,
            "previewUrl": preview_url,
            "docxFallbackSupported": false,
        }))
    }

    pub(super) async fn close_preview(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: LeaseIdArgs = parse(args)?;
        self.preview_proxy.revoke(args.lease_id).await;
        plugins::PluginArtifactPreviewService::new(
            self.plugin_control_plane.clone(),
            self.capability_broker.clone(),
        )
        .close("", Some(&args.lease_id.to_string()))
        .await
        .map_err(internal_error)?;
        Ok(Value::Null)
    }

    pub(super) async fn automation_list(&self) -> Result<Value, ApplicationError> {
        let records = self
            .automation_store()
            .list()
            .await
            .map_err(internal_error)?;
        serialize(records.into_iter().map(automation_view).collect::<Vec<_>>())
    }

    pub(crate) async fn automation_create(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AutomationInputArgs = parse(args)?;
        let draft = self.normalize_draft(args.input).await?;
        let record = self
            .automation_store()
            .create(draft, Utc::now())
            .await
            .map_err(internal_error)?;
        serialize(automation_view(record))
    }

    pub(super) async fn automation_create_workflow(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: WorkflowAutomationInputArgs = parse(args)?;
        let mut draft = args.input;
        draft.launch.workspace.root_folder =
            ProjectRepo::find_repos_for_project(&self.pool, draft.launch.workspace.project_id)
                .await
                .map_err(internal_error)?
                .into_iter()
                .next()
                .map(|repo| repo.path.to_string_lossy().to_string())
                .ok_or_else(|| ApplicationError::bad_request("project has no repository"))?;
        draft.launch.workspace.branch = draft
            .launch
            .workspace
            .branch
            .map(|branch| branch.trim().to_string())
            .filter(|branch| !branch.is_empty());
        draft
            .launch
            .validate()
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        let record = self
            .automation_store()
            .create_workflow(draft, Utc::now())
            .await
            .map_err(internal_error)?;
        serialize(automation_view(record))
    }

    pub(crate) async fn automation_update(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AutomationUpdateArgs = parse(args)?;
        let draft = self.normalize_draft(args.input).await?;
        let record = self
            .automation_store()
            .update(args.id, draft, Utc::now())
            .await
            .map_err(store_error)?;
        serialize(automation_view(record))
    }

    pub(super) async fn automation_set_enabled(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AutomationEnabledArgs = parse(args)?;
        self.automation_store()
            .set_enabled(args.id, args.enabled, Utc::now())
            .await
            .map_err(store_error)?;
        Ok(Value::Null)
    }

    pub(super) async fn automation_delete(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: IdArgs = parse(args)?;
        self.automation_store()
            .delete(args.id)
            .await
            .map_err(internal_error)?;
        Ok(Value::Null)
    }

    pub(super) async fn automation_run_now(&self, args: Value) -> Result<Value, ApplicationError> {
        if !self.automation_ownership.current() {
            return Err(ApplicationError::capability_unavailable(
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

    pub(super) async fn automation_cancel_run(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: RunIdArgs = parse(args)?;
        let store = self.automation_store();
        if !store
            .request_cancel(args.run_id)
            .await
            .map_err(internal_error)?
        {
            return Err(ApplicationError::conflict("automation run is not running"));
        }
        if let Some(run) = store.run(args.run_id).await.map_err(internal_error)? {
            if let Some(conversation_id) = run.snapshot.conversation_id {
                ConversationSessionService::new(self.conversations.clone())
                    .cancel_turn(
                        conversation_id,
                        Some("automation run cancelled".to_string()),
                    )
                    .await
                    .map_err(internal_error)?;
            }
            if let Some(workflow_run_id) = run.workflow_run_id {
                application::WorkflowExecutionPort::cancel(
                    &application::WorkflowStoreExecutionPort::with_conversations(
                        self.pool.clone(),
                        self.conversations.clone(),
                    ),
                    Uuid::new_v4(),
                    application::CancelWorkflowRequest {
                        run_id: workflow_run_id,
                        reason: Some("automation run cancelled".to_string()),
                    },
                )
                .await?;
            }
        }
        self.automation
            .reconcile_running_turns()
            .await
            .map_err(ApplicationError::internal)?;
        Ok(Value::Null)
    }

    pub(super) async fn automation_runs(&self, args: Value) -> Result<Value, ApplicationError> {
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

    pub(super) fn automation_preview(&self, args: Value) -> Result<Value, ApplicationError> {
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

    pub(super) fn automation_templates(&self) -> Result<Value, ApplicationError> {
        serialize(
            BuiltinTemplateCatalog::all()
                .into_iter()
                .map(|template| json!({ "id": template.id, "draft": template.draft }))
                .collect::<Vec<_>>(),
        )
    }

    pub(super) async fn automation_unseen_failures(&self) -> Result<Value, ApplicationError> {
        Ok(json!(
            self.automation_store()
                .unseen_failure_count()
                .await
                .map_err(internal_error)?
        ))
    }

    pub(super) async fn automation_mark_seen(&self) -> Result<Value, ApplicationError> {
        self.automation_store()
            .mark_all_seen()
            .await
            .map_err(internal_error)?;
        Ok(Value::Null)
    }

    pub(super) async fn automation_export_spec(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: IdArgs = parse(args)?;
        let record = self
            .automation_store()
            .find(args.id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| ApplicationError::not_found("Automation not found"))?;
        let target = match record.target {
            AutomationTarget::Turn(spec) => {
                PortableAutomationTarget::Turn(PortableTurnLaunchSpec {
                    prompt_blocks: spec.prompt_blocks,
                    display_text: spec.display_text,
                    agent: spec.agent,
                    mode_id: spec.mode_id,
                    config_values: spec.config_values,
                    plugin_actions: spec.plugin_actions,
                    skills: spec.skills,
                    workspace: self.portable_workspace(&spec.workspace).await?,
                    label_snapshot: spec.label_snapshot,
                })
            }
            AutomationTarget::Workflow(spec) => {
                let version = workflows::WorkflowStore::new(self.pool.clone())
                    .version(spec.definition_version_id)
                    .await
                    .map_err(|error| ApplicationError::internal(error.to_string()))?;
                let source_path = version.source_path.ok_or_else(|| {
                    ApplicationError::conflict(
                        "Workflow version has no portable source identity; publish it from Studio first",
                    )
                })?;
                PortableAutomationTarget::Workflow(PortableWorkflowLaunchSpec {
                    source_path,
                    version_digest: version.digest,
                    input: spec.input,
                    policy_override: spec.policy_override,
                    workspace: self.portable_workspace(&spec.workspace).await?,
                })
            }
        };
        let spec = AutomationSpec {
            format_version: PORTABLE_AUTOMATION_SPEC_VERSION,
            name: record.name,
            trigger: record.trigger,
            target,
        };
        spec.validate()
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        serialize(
            serde_json::to_string_pretty(&spec)
                .map_err(|error| ApplicationError::internal(error.to_string()))?,
        )
    }

    pub(super) async fn automation_import_spec(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AutomationImportArgs = parse(args)?;
        let spec: AutomationSpec = serde_json::from_str(&args.json).map_err(|error| {
            ApplicationError::bad_request(format!("Invalid Automation JSON: {error}"))
        })?;
        spec.validate()
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        let record = match spec.target {
            PortableAutomationTarget::Turn(launch) => {
                let workspace = self.resolve_portable_workspace(&launch.workspace).await?;
                let draft = AutomationDraft {
                    name: spec.name,
                    enabled: false,
                    trigger: spec.trigger,
                    launch: AutomationDraftInput(TurnLaunchSpecInput {
                        prompt_blocks: launch.prompt_blocks,
                        display_text: launch.display_text,
                        agent: launch.agent,
                        mode_id: launch.mode_id,
                        config_values: launch.config_values,
                        plugin_actions: launch.plugin_actions,
                        skills: launch.skills,
                        workspace,
                        label_snapshot: launch.label_snapshot,
                    }),
                };
                self.automation_store()
                    .create(draft, Utc::now())
                    .await
                    .map_err(internal_error)?
            }
            PortableAutomationTarget::Workflow(launch) => {
                let workspace = self.resolve_portable_workspace(&launch.workspace).await?;
                let version = workflows::WorkflowStore::new(self.pool.clone())
                    .version_by_source_digest(&launch.source_path, &launch.version_digest)
                    .await
                    .map_err(|error| ApplicationError::conflict(error.to_string()))?;
                self.automation_store()
                    .create_workflow(
                        WorkflowAutomationDraft {
                            name: spec.name,
                            enabled: false,
                            trigger: spec.trigger,
                            launch: WorkflowLaunchSpec {
                                spec_version: WORKFLOW_AUTOMATION_SPEC_VERSION,
                                definition_version_id: version.id,
                                input: launch.input,
                                policy_override: launch.policy_override,
                                workspace,
                            },
                        },
                        Utc::now(),
                    )
                    .await
                    .map_err(internal_error)?
            }
        };
        serialize(automation_view(record))
    }

    pub(super) async fn portable_workspace(
        &self,
        workspace: &WorkspaceTarget,
    ) -> Result<PortableWorkspaceRef, ApplicationError> {
        let project = Project::find_by_id(&self.pool, workspace.project_id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| ApplicationError::not_found("Automation project not found"))?;
        let root_folder_name = std::path::Path::new(&workspace.root_folder)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .ok_or_else(|| ApplicationError::conflict("Automation workspace root is not portable"))?
            .to_string();
        Ok(PortableWorkspaceRef {
            project_name: project.name,
            root_folder_name,
            branch: workspace.branch.clone(),
            isolation: workspace.isolation.clone(),
        })
    }

    pub(super) async fn resolve_portable_workspace(
        &self,
        reference: &PortableWorkspaceRef,
    ) -> Result<WorkspaceTarget, ApplicationError> {
        let projects = Project::find_all(&self.pool)
            .await
            .map_err(internal_error)?;
        let matches = projects
            .into_iter()
            .filter(|project| project.name == reference.project_name)
            .collect::<Vec<_>>();
        let [project] = matches.as_slice() else {
            return Err(ApplicationError::conflict(format!(
                "Project `{}` is missing or ambiguous",
                reference.project_name
            )));
        };
        let repos = ProjectRepo::find_repos_for_project(&self.pool, project.id)
            .await
            .map_err(internal_error)?;
        let roots = repos
            .into_iter()
            .filter(|repo| {
                repo.name == reference.root_folder_name
                    || std::path::Path::new(&repo.path)
                        .file_name()
                        .and_then(|name| name.to_str())
                        == Some(reference.root_folder_name.as_str())
            })
            .collect::<Vec<_>>();
        let [repo] = roots.as_slice() else {
            return Err(ApplicationError::conflict(format!(
                "Workspace root `{}` is missing or ambiguous in project `{}`",
                reference.root_folder_name, reference.project_name
            )));
        };
        Ok(WorkspaceTarget {
            project_id: project.id,
            root_folder: repo.path.to_string_lossy().into_owned(),
            branch: reference.branch.clone(),
            isolation: reference.isolation.clone(),
        })
    }

    pub(super) async fn delegation_cancel(&self, args: Value) -> Result<Value, ApplicationError> {
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

    pub(super) async fn normalize_draft(
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
        let action_catalog = self.unified_action_catalog().await?;
        TurnLaunchSpec::from_automation_draft(draft.launch.clone())
            .and_then(|spec| spec.validate_plugin_actions(&action_catalog))
            .map_err(|error| ApplicationError::bad_request(format!("{}: {error}", error.code())))?;
        Ok(draft)
    }

    pub(super) async fn unified_action_catalog(&self) -> Result<UnifiedActionCatalog, ApplicationError> {
        let control_plane = self.plugin_control_plane().await?;
        let actions = control_plane
            .catalog()
            .await
            .map_err(internal_error)?
            .into_iter()
            .filter(|plugin| plugin.activation == plugins::PluginActivation::Enabled)
            .flat_map(|plugin| {
                let plugin_id = plugin.id().to_owned();
                plugin
                    .package
                    .invocations
                    .into_iter()
                    .filter(|invocation| invocation.kind == plugins::InvocationKind::Action)
                    .map(move |invocation| (plugin_id.clone(), invocation.id))
            })
            .collect();
        Ok(UnifiedActionCatalog { actions })
    }
}
