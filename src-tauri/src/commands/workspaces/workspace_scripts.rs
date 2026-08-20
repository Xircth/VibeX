use db::models::{
    execution_process::{ExecutionProcess, ExecutionProcessRunReason, ExecutionProcessStatus},
    session::{CreateSession, Session, SessionStatus},
    workspace::Workspace,
    workspace_repo::WorkspaceRepo,
};
use executors::actions::{ExecutorAction, script::ScriptContext};
use services::services::container_actions;
use uuid::Uuid;

use super::{
    GhCliSetupError, GhCliSetupResult, OpenEditorResponse, RunScriptError, RunScriptResult,
};
use crate::{
    error::AppError,
    state::AppState,
    workspace_paths::{
        resolve_workspace_default_open_path, resolve_workspace_repo_root,
        resolve_workspace_repo_script_working_dir,
    },
};

#[tauri::command]
pub async fn start_workspace_dev_server(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<Vec<ExecutionProcess>, AppError> {
    let pool = &state.deployment.db().pool;

    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;

    // Get parent task
    let task = workspace
        .parent_task(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Parent task not found".to_string()))?;

    // Get parent project
    let project = task
        .parent_project(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Parent project not found".to_string()))?;

    // Stop any existing dev servers for this project
    let existing_dev_servers =
        ExecutionProcess::find_running_dev_servers_by_project(pool, project.id)
            .await
            .map_err(|e| {
                tracing::error!(
                    "Failed to find running dev servers for project {}: {}",
                    project.id,
                    e
                );
                AppError::Internal(e.to_string())
            })?;

    for dev_server in existing_dev_servers {
        tracing::info!(
            "Stopping existing dev server {} for project {}",
            dev_server.id,
            project.id
        );

        if let Err(e) = state
            .deployment
            .container()
            .stop_execution(&dev_server, ExecutionProcessStatus::Killed)
            .await
        {
            tracing::error!("Failed to stop dev server {}: {}", dev_server.id, e);
        }
    }

    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let repos_with_dev_script: Vec<_> = repos
        .iter()
        .filter(|r| r.dev_server_script.as_ref().is_some_and(|s| !s.is_empty()))
        .collect();

    if repos_with_dev_script.is_empty() {
        return Err(AppError::BadRequest(
            "No dev server script configured for any repository in this workspace".to_string(),
        ));
    }

    let session = match Session::find_latest_by_workspace_id(pool, workspace.id).await? {
        Some(s) => s,
        None => {
            Session::create(
                pool,
                &CreateSession {
                    executor: Some("dev-server".to_string()),
                    agent_id: None,
                    task_id: None,
                    name: None,
                    initial_prompt: None,
                    status: Some(SessionStatus::Todo),
                },
                Uuid::new_v4(),
                workspace.id,
            )
            .await?
        }
    };

    let mut execution_processes = Vec::new();
    let container_ref = state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;

    for repo in repos_with_dev_script {
        let working_dir =
            resolve_workspace_repo_script_working_dir(&workspace, &container_ref, &repos, repo);
        let Some(executor_action) =
            container_actions::dev_server_action_for_repo(repo, working_dir)
        else {
            continue;
        };

        let execution_process = state
            .deployment
            .container()
            .start_execution(
                &workspace,
                &session,
                &executor_action,
                &ExecutionProcessRunReason::DevServer,
            )
            .await?;
        execution_processes.push(execution_process);
    }

    Ok(execution_processes)
}

#[tauri::command]
pub async fn gh_cli_setup(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<GhCliSetupResult, AppError> {
    let pool = &state.deployment.db().pool;

    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;

    let executor_action = get_gh_cli_setup_action().await;
    let executor_action = match executor_action {
        Ok(action) => action,
        Err(AppError::BadRequest(msg)) if msg.contains("brew") => {
            return Ok(GhCliSetupResult {
                process: None,
                error: Some(GhCliSetupError::BrewMissing),
            });
        }
        Err(AppError::BadRequest(msg)) if msg.contains("not supported") => {
            return Ok(GhCliSetupResult {
                process: None,
                error: Some(GhCliSetupError::SetupHelperNotSupported),
            });
        }
        Err(e) => {
            return Ok(GhCliSetupResult {
                process: None,
                error: Some(GhCliSetupError::Other {
                    message: e.to_string(),
                }),
            });
        }
    };

    state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;

    let session = match Session::find_latest_by_workspace_id(pool, workspace.id).await? {
        Some(s) => s,
        None => {
            Session::create(
                pool,
                &CreateSession {
                    executor: Some("gh-cli".to_string()),
                    agent_id: None,
                    task_id: None,
                    name: None,
                    initial_prompt: None,
                    status: Some(SessionStatus::Todo),
                },
                Uuid::new_v4(),
                workspace.id,
            )
            .await?
        }
    };

    let execution_process = state
        .deployment
        .container()
        .start_execution(
            &workspace,
            &session,
            &executor_action,
            &ExecutionProcessRunReason::SetupScript,
        )
        .await?;

    Ok(GhCliSetupResult {
        process: Some(execution_process),
        error: None,
    })
}

async fn get_gh_cli_setup_action() -> Result<ExecutorAction, AppError> {
    let gh = crate::commands::github_cli_installer::install()
        .await
        .map_err(AppError::BadRequest)?;
    let quoted = format!("\"{}\"", gh.display().to_string().replace('"', "\\\""));
    let auth_script = format!(
        "export GH_PROMPT_DISABLED=1\n{quoted} auth login --web --git-protocol https --skip-ssh-key\n"
    );
    Ok(container_actions::script_action(
        auth_script,
        ScriptContext::ToolInstallScript,
        None,
        None,
    ))
}

#[tauri::command]
pub async fn run_setup_script(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<RunScriptResult, AppError> {
    let pool = &state.deployment.db().pool;

    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;

    if ExecutionProcess::has_running_non_dev_server_processes_for_workspace(pool, workspace.id)
        .await?
    {
        return Ok(RunScriptResult {
            process: None,
            error: Some(RunScriptError::ProcessAlreadyRunning),
        });
    }

    state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;

    let task = workspace
        .parent_task(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Parent task not found".to_string()))?;

    let _project = task
        .parent_project(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Parent project not found".to_string()))?;

    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let executor_action = match container_actions::setup_actions_for_repos(&repos) {
        Some(action) => action,
        None => {
            return Ok(RunScriptResult {
                process: None,
                error: Some(RunScriptError::NoScriptConfigured),
            });
        }
    };

    let session = match Session::find_latest_by_workspace_id(pool, workspace.id).await? {
        Some(s) => s,
        None => {
            Session::create(
                pool,
                &CreateSession {
                    executor: None,
                    agent_id: None,
                    task_id: None,
                    name: None,
                    initial_prompt: None,
                    status: Some(SessionStatus::Todo),
                },
                Uuid::new_v4(),
                workspace.id,
            )
            .await?
        }
    };

    let execution_process = state
        .deployment
        .container()
        .start_execution(
            &workspace,
            &session,
            &executor_action,
            &ExecutionProcessRunReason::SetupScript,
        )
        .await?;

    Ok(RunScriptResult {
        process: Some(execution_process),
        error: None,
    })
}

#[tauri::command]
pub async fn run_cleanup_script(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<RunScriptResult, AppError> {
    let pool = &state.deployment.db().pool;

    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;

    if ExecutionProcess::has_running_non_dev_server_processes_for_workspace(pool, workspace.id)
        .await?
    {
        return Ok(RunScriptResult {
            process: None,
            error: Some(RunScriptError::ProcessAlreadyRunning),
        });
    }

    state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;

    let task = workspace
        .parent_task(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Parent task not found".to_string()))?;

    let _project = task
        .parent_project(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Parent project not found".to_string()))?;

    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let executor_action = match container_actions::cleanup_actions_for_repos(&repos) {
        Some(action) => action,
        None => {
            return Ok(RunScriptResult {
                process: None,
                error: Some(RunScriptError::NoScriptConfigured),
            });
        }
    };

    let session = match Session::find_latest_by_workspace_id(pool, workspace.id).await? {
        Some(s) => s,
        None => {
            Session::create(
                pool,
                &CreateSession {
                    executor: None,
                    agent_id: None,
                    task_id: None,
                    name: None,
                    initial_prompt: None,
                    status: Some(SessionStatus::Todo),
                },
                Uuid::new_v4(),
                workspace.id,
            )
            .await?
        }
    };

    let execution_process = state
        .deployment
        .container()
        .start_execution(
            &workspace,
            &session,
            &executor_action,
            &ExecutionProcessRunReason::CleanupScript,
        )
        .await?;

    Ok(RunScriptResult {
        process: Some(execution_process),
        error: None,
    })
}

#[tauri::command]
pub async fn run_archive_script(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
) -> Result<RunScriptResult, AppError> {
    let pool = &state.deployment.db().pool;

    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;

    if ExecutionProcess::has_running_non_dev_server_processes_for_workspace(pool, workspace.id)
        .await?
    {
        return Ok(RunScriptResult {
            process: None,
            error: Some(RunScriptError::ProcessAlreadyRunning),
        });
    }

    state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;

    let task = workspace
        .parent_task(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Parent task not found".to_string()))?;

    let _project = task
        .parent_project(pool)
        .await?
        .ok_or_else(|| AppError::NotFound("Parent project not found".to_string()))?;

    let repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let executor_action = match container_actions::archive_actions_for_repos(&repos) {
        Some(action) => action,
        None => {
            return Ok(RunScriptResult {
                process: None,
                error: Some(RunScriptError::NoScriptConfigured),
            });
        }
    };

    let session = match Session::find_latest_by_workspace_id(pool, workspace.id).await? {
        Some(s) => s,
        None => {
            Session::create(
                pool,
                &CreateSession {
                    executor: None,
                    agent_id: None,
                    task_id: None,
                    name: None,
                    initial_prompt: None,
                    status: Some(SessionStatus::Todo),
                },
                Uuid::new_v4(),
                workspace.id,
            )
            .await?
        }
    };

    let execution_process = state
        .deployment
        .container()
        .start_execution(
            &workspace,
            &session,
            &executor_action,
            &ExecutionProcessRunReason::ArchiveScript,
        )
        .await?;

    Ok(RunScriptResult {
        process: Some(execution_process),
        error: None,
    })
}

#[tauri::command]
pub async fn open_workspace_in_editor(
    state: tauri::State<'_, AppState>,
    workspace_id: Uuid,
    editor_type: Option<String>,
    file_path: Option<String>,
) -> Result<OpenEditorResponse, AppError> {
    let pool = &state.deployment.db().pool;

    let workspace = Workspace::find_by_id(pool, workspace_id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("Workspace {} not found", workspace_id)))?;

    let container_ref = state
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await?;

    Workspace::touch(pool, workspace.id).await?;

    let workspace_repos = WorkspaceRepo::find_repos_for_workspace(pool, workspace.id).await?;
    let path = if let Some(ref fp) = file_path {
        resolve_workspace_repo_root(&workspace, &container_ref, &workspace_repos).join(fp)
    } else {
        resolve_workspace_default_open_path(&workspace, &container_ref, &workspace_repos)
    };

    let editor_config = {
        let config = state.deployment.config().read().await;
        let editor_type_str = editor_type.as_deref();
        config.editor.with_override(editor_type_str)
    };

    match editor_config.open_file(path.as_path()).await {
        Ok(url) => {
            tracing::info!(
                "Opened editor for workspace {} at path: {}{}",
                workspace.id,
                path.display(),
                if url.is_some() { " (remote mode)" } else { "" }
            );

            Ok(OpenEditorResponse { url })
        }
        Err(e) => {
            tracing::error!(
                "Failed to open editor for workspace {}: {:?}",
                workspace.id,
                e
            );
            Err(AppError::Internal(format!("Failed to open editor: {}", e)))
        }
    }
}
