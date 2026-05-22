fn app_error_from_native(provider: ProviderId, error: impl Into<String>) -> AppError {
    AppError::BadRequest(format!(
        "{} native runtime failed: {}",
        provider.label(),
        error.into()
    ))
}

fn provider_fallback_status(provider: ProviderId) -> CapabilityStatus {
    let fallback = acp_fallback_config(provider);
    let contract = provider_runtime_contract(provider);
    if !fallback.enabled {
        let env_name = fallback
            .env_name
            .map(str::to_string)
            .unwrap_or_else(|| contract.global_fallback_env.clone());
        return CapabilityStatus::unavailable(
            contract.fallback_source,
            format!(
                "{} ACP compatibility fallback is disabled by `{}`.",
                provider.label(),
                env_name
            ),
        );
    }

    CapabilityStatus::available(contract.fallback_source).with_detail(format!(
        "{} can still use the provider-scoped ACP compatibility adapter controlled by `{}`.",
        provider.label(),
        contract.fallback_env
    ))
}

impl CapabilityStatus {
    fn with_detail(mut self, detail: impl Into<String>) -> Self {
        self.detail = Some(detail.into());
        self
    }
}

async fn probe_native_runtime(provider: ProviderId) -> CapabilityStatus {
    let contract = provider_runtime_contract(provider);
    let (program, args, expected) = match provider {
        ProviderId::Claude => (
            "node",
            vec![
                claude_sdk_bridge_script_path()
                    .to_string_lossy()
                    .to_string(),
                "--probe".to_string(),
            ],
            "claude-agent-sdk-provider:ok",
        ),
        ProviderId::Codex => (
            "codex",
            vec!["app-server".to_string(), "--help".to_string()],
            "Run the app server",
        ),
        ProviderId::Opencode => (
            "node",
            vec![
                opencode_sdk_bridge_script_path()
                    .to_string_lossy()
                    .to_string(),
                "--probe".to_string(),
            ],
            "opencode-sdk-provider:ok",
        ),
    };

    let output = tokio::time::timeout(Duration::from_secs(4), async move {
        new_provider_hidden_command(program, args)
            .await
            .output()
            .await
    })
    .await;

    match output {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            let combined = format!("{stdout}\n{stderr}");
            if combined.contains(expected) {
                CapabilityStatus::available(contract.primary_source).with_detail(format!(
                    "{} primary runtime probe passed via `{program}` ({}).",
                    provider.label(),
                    contract.primary_label
                ))
            } else {
                CapabilityStatus::partial(
                    contract.primary_source,
                    format!(
                        "{} was found, but expected primary runtime marker `{expected}` was not present.",
                        provider.label()
                    ),
                )
            }
        }
        Ok(Err(error)) => CapabilityStatus::unavailable(
            contract.primary_source,
            format!(
                "Failed to launch `{program}` for {} primary runtime {}: {error}",
                provider.label(),
                contract.primary_label
            ),
        ),
        Err(_) => CapabilityStatus::unavailable(
            contract.primary_source,
            format!(
                "Timed out probing `{program}` for {} primary runtime {}.",
                provider.label(),
                contract.primary_label
            ),
        ),
    }
}

async fn ensure_provider_session(
    state: &tauri::State<'_, AppState>,
    provider: ProviderId,
    workspace_id: Uuid,
    session_id: Option<&str>,
    initial_prompt: &str,
) -> Result<Session, AppError> {
    let pool = &state.deployment.db().pool;

    if let Some(session_id) = session_id {
        let session_uuid = Uuid::parse_str(session_id)
            .map_err(|_| AppError::BadRequest(format!("Invalid session id: {session_id}")))?;
        let session = Session::find_by_id(pool, session_uuid)
            .await?
            .ok_or_else(|| AppError::NotFound(format!("Session {session_id} not found")))?;
        if session.workspace_id != workspace_id {
            return Err(AppError::BadRequest(format!(
                "Session {} does not belong to workspace {}",
                session.id, workspace_id
            )));
        }
        if !session_executor_matches_provider(session.executor.as_deref(), provider) {
            return Err(AppError::BadRequest(format!(
                "Session {} belongs to a different provider",
                session.id
            )));
        }
        return Ok(session);
    }

    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {workspace_id} not found")))?;

    Session::create(
        pool,
        &CreateSession {
            executor: Some(provider.base_agent().to_string()),
            task_id: Some(workspace.task_id),
            name: Some(format!("{} native provider turn", provider.label())),
            initial_prompt: Some(initial_prompt.to_string()),
            status: Some(SessionStatus::Todo),
        },
        Uuid::new_v4(),
        workspace.id,
    )
    .await
    .map_err(AppError::from)
}

async fn resolve_provider_workspace_dir(
    state: &tauri::State<'_, AppState>,
    workspace: &mut Workspace,
) -> Result<PathBuf, AppError> {
    let container_ref = state
        .deployment
        .container()
        .ensure_container_exists(workspace)
        .await?;
    workspace.container_ref = Some(container_ref.clone());
    let repos =
        WorkspaceRepo::find_repos_for_workspace(&state.deployment.db().pool, workspace.id).await?;
    let agent_working_dir = resolve_workspace_agent_working_dir(workspace, &container_ref, &repos);
    state
        .deployment
        .image()
        .copy_images_by_task_to_worktree(
            &PathBuf::from(&container_ref),
            workspace.task_id,
            agent_working_dir.as_deref(),
        )
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?;

    Ok(agent_working_dir
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(container_ref)))
}

async fn load_provider_workspace(
    state: &tauri::State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<Workspace, AppError> {
    Workspace::find_by_id(&state.deployment.db().pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {workspace_id} not found")))
}

async fn create_native_execution_process(
    state: &tauri::State<'_, AppState>,
    workspace: &Workspace,
    session: &Session,
    request: &ProviderTurnRequest,
    visible_prompt: &str,
    agent_session_id: Option<String>,
    native_message_id: Option<String>,
) -> Result<ExecutionProcess, AppError> {
    let pool = &state.deployment.db().pool;
    let repositories = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    if repositories.is_empty() {
        return Err(AppError::BadRequest(format!(
            "Workspace {} has no repositories configured",
            workspace.id
        )));
    }

    let workspace_root = workspace
        .container_ref
        .as_ref()
        .map(PathBuf::from)
        .ok_or_else(|| AppError::BadRequest("Workspace container ref not found".to_string()))?;

    let mut repo_states = Vec::with_capacity(repositories.len());
    for repo in &repositories {
        let repo_path = workspace
            .repo_path(repo)
            .unwrap_or_else(|| workspace_root.clone());
        let before_head_commit = state
            .deployment
            .git()
            .get_head_info(&repo_path)
            .ok()
            .map(|head| head.oid);
        repo_states.push(CreateExecutionProcessRepoState {
            repo_id: repo.id,
            before_head_commit,
            after_head_commit: None,
            merge_commit: None,
        });
    }

    let working_dir = resolve_workspace_agent_working_dir(
        workspace,
        workspace_root.to_string_lossy().as_ref(),
        &repositories,
    );
    let executor_config = provider_executor_config(request);
    let action_type = if let Some(agent_session_id) = agent_session_id.clone() {
        ExecutorActionType::CodingAgentFollowUpRequest(CodingAgentFollowUpRequest {
            prompt: visible_prompt.to_string(),
            session_id: agent_session_id,
            reset_to_message_id: None,
            executor_config,
            working_dir,
        })
    } else {
        ExecutorActionType::CodingAgentInitialRequest(CodingAgentInitialRequest {
            prompt: visible_prompt.to_string(),
            executor_config,
            working_dir,
        })
    };
    let action = ExecutorAction::new(action_type, None);
    let process = ExecutionProcess::create(
        pool,
        &CreateExecutionProcess {
            session_id: session.id,
            executor_action: action,
            run_reason: ExecutionProcessRunReason::CodingAgent,
        },
        Uuid::new_v4(),
        &repo_states,
    )
    .await?;

    CodingAgentTurn::create(
        pool,
        &CreateCodingAgentTurn {
            execution_process_id: process.id,
            prompt: Some(visible_prompt.to_string()),
        },
        Uuid::new_v4(),
    )
    .await?;

    if let Some(agent_session_id) = agent_session_id.as_deref() {
        CodingAgentTurn::update_agent_session_id(pool, process.id, agent_session_id).await?;
    }
    if let Some(native_message_id) = native_message_id.as_deref() {
        CodingAgentTurn::update_agent_message_id(pool, process.id, native_message_id).await?;
    }
    Session::update_status(pool, session.id, SessionStatus::InProgress).await?;

    Ok(process)
}

fn prompt_with_display_images(message: &str, images: &[String]) -> String {
    if images.is_empty() {
        return message.to_string();
    }

    let image_markdown = images
        .iter()
        .filter_map(|image| {
            let image = image.trim();
            if image.is_empty() {
                None
            } else {
                Some(format!("![]({image})"))
            }
        })
        .collect::<Vec<_>>()
        .join("\n");

    if image_markdown.is_empty() {
        return message.to_string();
    }

    if message.trim().is_empty() {
        image_markdown
    } else {
        format!("{message}\n\n{image_markdown}")
    }
}

fn provider_request_with_resolved_thread_id(
    mut request: ProviderTurnRequest,
    latest_session_id: Option<String>,
) -> ProviderTurnRequest {
    if request.thread_id.is_none() {
        request.thread_id = latest_session_id;
    }
    request
}

async fn resolve_native_provider_request(
    pool: &SqlitePool,
    session: &Session,
    request: ProviderTurnRequest,
) -> Result<ProviderTurnRequest, AppError> {
    if request.thread_id.is_some() {
        return Ok(request);
    }

    let latest_session_id = CodingAgentTurn::find_latest_session_info(pool, session.id)
        .await?
        .map(|info| info.session_id);
    Ok(provider_request_with_resolved_thread_id(
        request,
        latest_session_id,
    ))
}

