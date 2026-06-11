use std::{path::PathBuf, process::Output};

use db::models::{
    coding_agent_turn::{CodingAgentTurn, CreateCodingAgentTurn},
    execution_process::{CreateExecutionProcess, ExecutionProcess, ExecutionProcessRunReason},
    execution_process_repo_state::CreateExecutionProcessRepoState,
    session::{CreateSession, Session, SessionStatus},
    workspace::Workspace,
    workspace_repo::WorkspaceRepo,
};
use deployment::Deployment;
use executors::actions::{
    ExecutorAction, ExecutorActionType, coding_agent_follow_up::CodingAgentFollowUpRequest,
    coding_agent_initial::CodingAgentInitialRequest,
};
use services::services::container::ContainerService;
use sqlx::SqlitePool;
use tokio::time::Duration;
use uuid::Uuid;

use super::{
    CapabilitySource, CapabilityStatus, ProviderId, ProviderRuntimeDependencyStatus,
    ProviderTurnRequest, acp_fallback_config, claude_sdk_bridge_script_path,
    new_provider_hidden_command, opencode_sdk_bridge_script_path, provider_executor_config,
    provider_runtime_contract, session_executor_matches_provider,
};
use crate::{
    error::AppError, state::AppState, workspace_paths::resolve_workspace_agent_working_dir,
};

pub(super) fn app_error_from_native(provider: ProviderId, error: impl Into<String>) -> AppError {
    AppError::BadRequest(format!(
        "{} native runtime failed: {}",
        provider.label(),
        error.into()
    ))
}

pub(super) fn provider_sdk_metadata_failure_error(
    provider: ProviderId,
    output: &Output,
) -> AppError {
    app_error_from_native(
        provider,
        utils::process::command_output_detail(output)
            .unwrap_or_else(|| "SDK metadata discovery failed".to_string()),
    )
}

pub(super) fn provider_fallback_status(provider: ProviderId) -> CapabilityStatus {
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

struct RuntimeProbe {
    program: &'static str,
    expected_marker: &'static str,
    output: Result<Output, String>,
}

fn dependency_status(
    id: &str,
    label: &str,
    required: bool,
    user_visible: bool,
    status: CapabilityStatus,
) -> ProviderRuntimeDependencyStatus {
    ProviderRuntimeDependencyStatus {
        id: id.to_string(),
        label: label.to_string(),
        required,
        user_visible,
        status,
    }
}

fn output_text(output: &Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    format!("{stdout}\n{stderr}")
}

fn text_mentions_any(text: &str, needles: &[&str]) -> bool {
    let lower = text.to_ascii_lowercase();
    needles.iter().any(|needle| lower.contains(needle))
}

fn launch_error_mentions_missing_program(error: &str, program: &str) -> bool {
    text_mentions_any(
        error,
        &[
            "not found",
            "no such file",
            "os error 2",
            "cannot find",
            "could not find",
            "enoent",
        ],
    ) || error.to_ascii_lowercase().contains(program)
}

fn sdk_package_missing(output: &Output, package_name: &str) -> bool {
    let text = output_text(output);
    text_mentions_any(&text, &["err_module_not_found", "cannot find package"])
        && text.contains(package_name)
}

fn opencode_cli_missing(output: &Output) -> bool {
    let text = output_text(output);
    text_mentions_any(
        &text,
        &["opencode", "enoent", "not recognized", "not found"],
    ) && !text.contains("@opencode-ai/sdk")
}

fn auth_or_config_missing(output: &Output) -> bool {
    text_mentions_any(
        &output_text(output),
        &[
            "auth",
            "authentication",
            "login",
            "not logged in",
            "api key",
            "token",
            "config",
            "permission denied",
        ],
    )
}

fn provider_dependency_statuses(
    provider: ProviderId,
    probe: &RuntimeProbe,
) -> Vec<ProviderRuntimeDependencyStatus> {
    match provider {
        ProviderId::Claude => claude_dependency_statuses(probe),
        ProviderId::Codex => codex_dependency_statuses(probe),
        ProviderId::Opencode => opencode_dependency_statuses(probe),
    }
}

fn claude_dependency_statuses(probe: &RuntimeProbe) -> Vec<ProviderRuntimeDependencyStatus> {
    let mut statuses = Vec::new();
    match &probe.output {
        Ok(output) if output_text(output).contains(probe.expected_marker) => {
            statuses.push(dependency_status(
                "node",
                "Node.js",
                true,
                true,
                CapabilityStatus::available(CapabilitySource::Native)
                    .with_detail("Node can run the Claude SDK bridge."),
            ));
            statuses.push(dependency_status(
                "claude_agent_sdk",
                "@anthropic-ai/claude-agent-sdk",
                true,
                false,
                CapabilityStatus::available(CapabilitySource::Sdk)
                    .with_detail("Claude Agent SDK bridge package resolved."),
            ));
        }
        Ok(output) if sdk_package_missing(output, "@anthropic-ai/claude-agent-sdk") => {
            statuses.push(dependency_status(
                "node",
                "Node.js",
                true,
                true,
                CapabilityStatus::available(CapabilitySource::Native)
                    .with_detail("Node launched, but the Claude SDK package did not resolve."),
            ));
            statuses.push(dependency_status(
                "claude_agent_sdk",
                "@anthropic-ai/claude-agent-sdk",
                true,
                false,
                CapabilityStatus::unavailable(
                    CapabilitySource::Sdk,
                    "Missing bridge package `@anthropic-ai/claude-agent-sdk`.",
                ),
            ));
        }
        Ok(output) if auth_or_config_missing(output) => {
            statuses.push(dependency_status(
                "claude_auth_config",
                "Claude auth/config",
                true,
                true,
                CapabilityStatus::unavailable(
                    CapabilitySource::Config,
                    "Claude bridge launched but reported an auth or configuration problem.",
                ),
            ));
        }
        Ok(output) => {
            statuses.push(dependency_status(
                "claude_probe",
                "Claude SDK bridge",
                true,
                true,
                CapabilityStatus::partial(
                    CapabilitySource::Sdk,
                    format!(
                        "Claude bridge ran, but expected marker `{}` was missing: {}",
                        probe.expected_marker,
                        utils::process::command_output_detail(output)
                            .unwrap_or_else(|| "no output".to_string())
                    ),
                ),
            ));
        }
        Err(error) => {
            statuses.push(dependency_status(
                "node",
                "Node.js",
                true,
                true,
                if launch_error_mentions_missing_program(error, probe.program) {
                    CapabilityStatus::unavailable(
                        CapabilitySource::Native,
                        format!("Missing `node` executable: {error}"),
                    )
                } else {
                    CapabilityStatus::partial(
                        CapabilitySource::Native,
                        format!("Failed to launch `node`: {error}"),
                    )
                },
            ));
        }
    }
    statuses
}

fn codex_dependency_statuses(probe: &RuntimeProbe) -> Vec<ProviderRuntimeDependencyStatus> {
    let status = match &probe.output {
        Ok(output) if output_text(output).contains(probe.expected_marker) => {
            CapabilityStatus::available(CapabilitySource::AppServer)
                .with_detail("Codex CLI exposes `codex app-server`.")
        }
        Ok(output) if auth_or_config_missing(output) => CapabilityStatus::unavailable(
            CapabilitySource::Config,
            "Codex CLI was found but reported an auth or configuration problem.",
        ),
        Ok(output) => CapabilityStatus::partial(
            CapabilitySource::AppServer,
            format!(
                "Codex CLI ran, but expected app-server marker `{}` was missing: {}",
                probe.expected_marker,
                utils::process::command_output_detail(output)
                    .unwrap_or_else(|| "no output".to_string())
            ),
        ),
        Err(error) => {
            if launch_error_mentions_missing_program(error, probe.program) {
                CapabilityStatus::unavailable(
                    CapabilitySource::AppServer,
                    format!("Missing `codex` executable: {error}"),
                )
            } else {
                CapabilityStatus::partial(
                    CapabilitySource::AppServer,
                    format!("Failed to launch `codex`: {error}"),
                )
            }
        }
    };
    vec![dependency_status(
        "codex_cli",
        "Codex CLI",
        true,
        true,
        status,
    )]
}

fn opencode_dependency_statuses(probe: &RuntimeProbe) -> Vec<ProviderRuntimeDependencyStatus> {
    let mut statuses = Vec::new();
    match &probe.output {
        Ok(output) if output_text(output).contains(probe.expected_marker) => {
            statuses.push(dependency_status(
                "node",
                "Node.js",
                true,
                true,
                CapabilityStatus::available(CapabilitySource::Native)
                    .with_detail("Node can run the OpenCode SDK bridge."),
            ));
            statuses.push(dependency_status(
                "opencode_sdk",
                "@opencode-ai/sdk",
                true,
                false,
                CapabilityStatus::available(CapabilitySource::Sdk)
                    .with_detail("OpenCode SDK bridge package resolved."),
            ));
            statuses.push(dependency_status(
                "opencode_cli",
                "OpenCode CLI/server",
                true,
                true,
                CapabilityStatus::available(CapabilitySource::Native)
                    .with_detail("OpenCode CLI responded to `opencode --version`."),
            ));
        }
        Ok(output) if sdk_package_missing(output, "@opencode-ai/sdk") => {
            statuses.push(dependency_status(
                "node",
                "Node.js",
                true,
                true,
                CapabilityStatus::available(CapabilitySource::Native)
                    .with_detail("Node launched, but the OpenCode SDK package did not resolve."),
            ));
            statuses.push(dependency_status(
                "opencode_sdk",
                "@opencode-ai/sdk",
                true,
                false,
                CapabilityStatus::unavailable(
                    CapabilitySource::Sdk,
                    "Missing bridge package `@opencode-ai/sdk`.",
                ),
            ));
        }
        Ok(output) if opencode_cli_missing(output) => {
            statuses.push(dependency_status(
                "node",
                "Node.js",
                true,
                true,
                CapabilityStatus::available(CapabilitySource::Native)
                    .with_detail("Node can run the OpenCode SDK bridge."),
            ));
            statuses.push(dependency_status(
                "opencode_sdk",
                "@opencode-ai/sdk",
                true,
                false,
                CapabilityStatus::available(CapabilitySource::Sdk)
                    .with_detail("OpenCode SDK bridge package resolved."),
            ));
            statuses.push(dependency_status(
                "opencode_cli",
                "OpenCode CLI/server",
                true,
                true,
                CapabilityStatus::unavailable(
                    CapabilitySource::Native,
                    "Missing `opencode` executable required by the SDK bridge.",
                ),
            ));
        }
        Ok(output) if auth_or_config_missing(output) => {
            statuses.push(dependency_status(
                "opencode_auth_config",
                "OpenCode auth/config",
                true,
                true,
                CapabilityStatus::unavailable(
                    CapabilitySource::Config,
                    "OpenCode bridge launched but reported an auth or configuration problem.",
                ),
            ));
        }
        Ok(output) => {
            statuses.push(dependency_status(
                "opencode_probe",
                "OpenCode SDK bridge",
                true,
                true,
                CapabilityStatus::partial(
                    CapabilitySource::Sdk,
                    format!(
                        "OpenCode bridge ran, but expected marker `{}` was missing: {}",
                        probe.expected_marker,
                        utils::process::command_output_detail(output)
                            .unwrap_or_else(|| "no output".to_string())
                    ),
                ),
            ));
        }
        Err(error) => {
            statuses.push(dependency_status(
                "node",
                "Node.js",
                true,
                true,
                if launch_error_mentions_missing_program(error, probe.program) {
                    CapabilityStatus::unavailable(
                        CapabilitySource::Native,
                        format!("Missing `node` executable: {error}"),
                    )
                } else {
                    CapabilityStatus::partial(
                        CapabilitySource::Native,
                        format!("Failed to launch `node`: {error}"),
                    )
                },
            ));
        }
    }
    statuses
}

fn aggregate_native_status(
    provider: ProviderId,
    dependencies: &[ProviderRuntimeDependencyStatus],
) -> CapabilityStatus {
    let contract = provider_runtime_contract(provider);
    if let Some(dependency) = dependencies.iter().find(|dependency| {
        dependency.required && dependency.status.state == super::CapabilityState::Unavailable
    }) {
        return CapabilityStatus::unavailable(
            contract.primary_source,
            format!(
                "{} primary runtime is unavailable because `{}` is unavailable: {}",
                provider.label(),
                dependency.label,
                dependency.status.detail.as_deref().unwrap_or("no detail")
            ),
        );
    }
    if let Some(dependency) = dependencies.iter().find(|dependency| {
        dependency.required && dependency.status.state == super::CapabilityState::Partial
    }) {
        return CapabilityStatus::partial(
            contract.primary_source,
            format!(
                "{} primary runtime is partially available because `{}` needs attention: {}",
                provider.label(),
                dependency.label,
                dependency.status.detail.as_deref().unwrap_or("no detail")
            ),
        );
    }

    CapabilityStatus::available(contract.primary_source).with_detail(format!(
        "{} primary runtime probe passed ({}).",
        provider.label(),
        contract.primary_label
    ))
}

async fn run_runtime_probe(
    provider: ProviderId,
    program: &'static str,
    args: Vec<String>,
    expected_marker: &'static str,
) -> RuntimeProbe {
    let output = tokio::time::timeout(Duration::from_secs(4), async move {
        new_provider_hidden_command(program, args)
            .await
            .output()
            .await
    })
    .await;

    let output = match output {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(error)) => Err(error.to_string()),
        Err(_) => Err(format!(
            "Timed out probing `{program}` for {} primary runtime.",
            provider.label()
        )),
    };

    RuntimeProbe {
        program,
        expected_marker,
        output,
    }
}

pub(super) async fn probe_native_runtime_with_dependencies(
    provider: ProviderId,
) -> (CapabilityStatus, Vec<ProviderRuntimeDependencyStatus>) {
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

    let probe = run_runtime_probe(provider, program, args, expected).await;
    let dependencies = provider_dependency_statuses(provider, &probe);
    let native = aggregate_native_status(provider, &dependencies);
    (native, dependencies)
}

#[cfg(test)]
pub(super) fn dependency_statuses_for_probe_output_for_test(
    provider: ProviderId,
    program: &'static str,
    expected_marker: &'static str,
    output: Result<Output, String>,
) -> (CapabilityStatus, Vec<ProviderRuntimeDependencyStatus>) {
    let probe = RuntimeProbe {
        program,
        expected_marker,
        output,
    };
    let dependencies = provider_dependency_statuses(provider, &probe);
    let native = aggregate_native_status(provider, &dependencies);
    (native, dependencies)
}

pub(super) async fn ensure_provider_session(
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

pub(super) async fn resolve_provider_workspace_dir(
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

pub(super) async fn load_provider_workspace(
    state: &tauri::State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<Workspace, AppError> {
    Workspace::find_by_id(&state.deployment.db().pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {workspace_id} not found")))
}

pub(super) async fn create_native_execution_process(
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

pub(super) fn prompt_with_display_images(message: &str, images: &[String]) -> String {
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

pub(super) fn provider_request_with_resolved_thread_id(
    mut request: ProviderTurnRequest,
    latest_session_id: Option<String>,
) -> ProviderTurnRequest {
    if request.thread_id.is_none() {
        request.thread_id = latest_session_id;
    }
    request
}

pub(super) async fn resolve_native_provider_request(
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
