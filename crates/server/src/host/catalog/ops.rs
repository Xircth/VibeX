use std::time::{SystemTime, UNIX_EPOCH};

use application::{ApplicationError, DomainCommand};
use db::models::{
    execution_process::{ExecutionProcess, ExecutionProcessRunReason, ExecutionProcessStatus},
    execution_process_repo_state::ExecutionProcessRepoState,
    merge::Merge,
    project::Project,
    repo::Repo,
    session::{CreateSession, Session, SessionStatus},
    workspace::Workspace,
    workspace_repo::WorkspaceRepo,
};
use deployment::Deployment;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use services::services::{
    container_actions,
    git_host::{GitHostError, GitHostProvider, GitHostService, ProviderKind},
};
use utils::approvals::ApprovalResponse;
use uuid::Uuid;

use crate::{
    domains::{ServerApplicationDomains, internal_error, parse, serialize},
    host_ops::WorkspaceRepoArgs,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommitOpArgs {
    workspace_id: Uuid,
    repo_id: Uuid,
    sha: String,
    branch_name: Option<String>,
    mode: Option<git::ResetMode>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathInitArgs {
    path: String,
    display_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdsArgs {
    ids: Vec<Uuid>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdArgs {
    id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceIdArgs {
    workspace_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResetSessionArgs {
    session_id: Uuid,
    process_id: Uuid,
    force_when_dirty: Option<bool>,
    perform_git_reset: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalArgs {
    approval_id: String,
    response: ApprovalResponse,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageArgs {
    scope: Option<String>,
    project_id: Option<String>,
    date_range: Option<String>,
}

#[derive(Serialize)]
struct PrCommentsResponse {
    comments: Vec<services::services::git_host::UnifiedPrComment>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum GetPrCommentsError {
    NoPrAttached,
    CliNotInstalled { provider: ProviderKind },
    CliNotLoggedIn { provider: ProviderKind },
}

#[derive(Serialize)]
struct PrCommentsResult {
    response: Option<PrCommentsResponse>,
    error: Option<GetPrCommentsError>,
}

pub(super) async fn git_commit_op(
    domains: &ServerApplicationDomains,
    command: DomainCommand,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: CommitOpArgs = parse(args)?;
    if matches!(command, DomainCommand::GitCreateBranchAtCommit)
        && args.branch_name.as_deref().is_none_or(str::is_empty)
    {
        return Err(ApplicationError::bad_request("branchName required"));
    }
    let path = domains
        .worktree_path(WorkspaceRepoArgs {
            workspace_id: args.workspace_id,
            repo_id: args.repo_id,
        })
        .await?;
    let git = domains.deployment.git().clone();
    tokio::task::block_in_place(|| match command {
        DomainCommand::GitCherryPick => git.cherry_pick_commit(&path, &args.sha),
        DomainCommand::GitRevertCommit => git.revert_commit(&path, &args.sha),
        DomainCommand::GitResetToCommit => git.reset_to_commit(
            &path,
            &args.sha,
            &args.mode.unwrap_or(git::ResetMode::Mixed),
        ),
        DomainCommand::GitCreateBranchAtCommit => git.create_branch_at_commit(
            &path,
            args.branch_name.as_deref().unwrap_or_default(),
            &args.sha,
        ),
        _ => Ok(()),
    })
    .map_err(internal_error)?;
    Ok(Value::Null)
}

pub(super) async fn workspace_pr_comments(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: WorkspaceRepoArgs = parse(args)?;
    let workspace = domains.require_workspace(args.workspace_id).await?;
    let workspace_repo =
        WorkspaceRepo::find_by_workspace_and_repo_id(&domains.pool, workspace.id, args.repo_id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| ApplicationError::not_found("workspace repository not found"))?;
    let repo = Repo::find_by_id(&domains.pool, workspace_repo.repo_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| ApplicationError::not_found("repository not found"))?;
    let merges = Merge::find_by_workspace_and_repo_id(&domains.pool, workspace.id, args.repo_id)
        .await
        .map_err(internal_error)?;
    let pr_info = match merges.into_iter().next() {
        Some(Merge::Pr(pr_merge)) => pr_merge.pr_info,
        _ => {
            return serialize(PrCommentsResult {
                response: None,
                error: Some(GetPrCommentsError::NoPrAttached),
            });
        }
    };
    let git = domains.deployment.git();
    let remote = git
        .resolve_remote_for_branch(&repo.path, &workspace_repo.target_branch)
        .map_err(internal_error)?;
    let git_host = match GitHostService::from_url(&remote.url) {
        Ok(host) => host,
        Err(GitHostError::CliNotInstalled { provider }) => {
            return serialize(PrCommentsResult {
                response: None,
                error: Some(GetPrCommentsError::CliNotInstalled { provider }),
            });
        }
        Err(error) => return Err(internal_error(error)),
    };
    let provider = git_host.provider_kind();
    match git_host
        .get_pr_comments(&repo.path, &remote.url, pr_info.number)
        .await
    {
        Ok(comments) => serialize(PrCommentsResult {
            response: Some(PrCommentsResponse { comments }),
            error: None,
        }),
        Err(GitHostError::CliNotInstalled { provider }) => serialize(PrCommentsResult {
            response: None,
            error: Some(GetPrCommentsError::CliNotInstalled { provider }),
        }),
        Err(GitHostError::AuthFailed(_)) => serialize(PrCommentsResult {
            response: None,
            error: Some(GetPrCommentsError::CliNotLoggedIn { provider }),
        }),
        Err(error) => Err(internal_error(error)),
    }
}

pub(super) async fn init_repo_at_path(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: PathInitArgs = parse(args)?;
    serialize(
        domains
            .deployment
            .repo()
            .init_repo_at_path(
                &domains.pool,
                domains.deployment.git(),
                &args.path,
                args.display_name.as_deref(),
            )
            .await
            .map_err(internal_error)?,
    )
}

pub(super) async fn repos_batch(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: IdsArgs = parse(args)?;
    serialize(
        Repo::find_by_ids(&domains.pool, &args.ids)
            .await
            .map_err(internal_error)?,
    )
}

pub(super) async fn get_execution_process(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: IdArgs = parse(args)?;
    serialize(
        ExecutionProcess::find_by_id(&domains.pool, args.id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| {
                ApplicationError::not_found(format!("Execution process {} not found", args.id))
            })?,
    )
}

pub(super) async fn execution_process_repo_states(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: IdArgs = parse(args)?;
    let _process = ExecutionProcess::find_by_id(&domains.pool, args.id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| {
            ApplicationError::not_found(format!("Execution process {} not found", args.id))
        })?;
    serialize(
        ExecutionProcessRepoState::find_by_execution_process_id(&domains.pool, args.id)
            .await
            .map_err(internal_error)?,
    )
}

pub(super) async fn stop_execution_process(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: IdArgs = parse(args)?;
    let process = ExecutionProcess::find_by_id(&domains.pool, args.id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| {
            ApplicationError::not_found(format!("Execution process {} not found", args.id))
        })?;
    domains
        .deployment
        .container()
        .stop_execution(&process, ExecutionProcessStatus::Killed)
        .await
        .map_err(internal_error)?;
    Ok(Value::Null)
}

pub(super) async fn stop_workspace_execution(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: WorkspaceIdArgs = parse(args)?;
    let workspace = domains.require_workspace(args.workspace_id).await?;
    domains
        .deployment
        .container()
        .try_stop(&workspace, false)
        .await;
    Ok(Value::Null)
}

pub(super) async fn reset_session_process(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: ResetSessionArgs = parse(args)?;
    let _session = Session::find_by_id(&domains.pool, args.session_id)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| {
            ApplicationError::not_found(format!("Session {} not found", args.session_id))
        })?;
    domains
        .deployment
        .container()
        .reset_session_to_process(
            args.session_id,
            args.process_id,
            args.perform_git_reset.unwrap_or(true),
            args.force_when_dirty.unwrap_or(false),
        )
        .await
        .map_err(internal_error)?;
    Ok(Value::Null)
}

pub(super) async fn start_dev_server(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: WorkspaceIdArgs = parse(args)?;
    let workspace = domains.require_workspace(args.workspace_id).await?;
    let task = workspace
        .parent_task(&domains.pool)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| ApplicationError::not_found("Parent task not found"))?;
    let project = task
        .parent_project(&domains.pool)
        .await
        .map_err(internal_error)?
        .ok_or_else(|| ApplicationError::not_found("Parent project not found"))?;
    let existing = ExecutionProcess::find_running_dev_servers_by_project(&domains.pool, project.id)
        .await
        .map_err(internal_error)?;
    for process in existing {
        let _ = domains
            .deployment
            .container()
            .stop_execution(&process, ExecutionProcessStatus::Killed)
            .await;
    }
    let repos = WorkspaceRepo::find_repos_for_workspace(&domains.pool, workspace.id)
        .await
        .map_err(internal_error)?;
    let repos_with_script: Vec<_> = repos
        .iter()
        .filter(|repo| {
            repo.dev_server_script
                .as_ref()
                .is_some_and(|script| !script.is_empty())
        })
        .collect();
    if repos_with_script.is_empty() {
        return Err(ApplicationError::bad_request(
            "No dev server script configured for any repository in this workspace",
        ));
    }
    let session = match Session::find_latest_by_workspace_id(&domains.pool, workspace.id)
        .await
        .map_err(internal_error)?
    {
        Some(session) => session,
        None => Session::create(
            &domains.pool,
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
        .await
        .map_err(internal_error)?,
    };
    let container_ref = domains
        .deployment
        .container()
        .ensure_container_exists(&workspace)
        .await
        .map_err(internal_error)?;
    let mut processes = Vec::new();
    for repo in repos_with_script {
        let working_dir = workspace
            .repo_path(repo)
            .map(|path| path.to_string_lossy().into_owned())
            .or_else(|| Some(container_ref.clone()));
        let Some(action) = container_actions::dev_server_action_for_repo(repo, working_dir) else {
            continue;
        };
        let process = domains
            .deployment
            .container()
            .start_execution(
                &workspace,
                &session,
                &action,
                &ExecutionProcessRunReason::DevServer,
            )
            .await
            .map_err(internal_error)?;
        processes.push(process);
    }
    serialize(processes)
}

pub(super) async fn first_user_message(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: WorkspaceIdArgs = parse(args)?;
    serialize(
        Workspace::get_first_user_message(&domains.pool, args.workspace_id)
            .await
            .map_err(internal_error)?,
    )
}

pub(super) async fn respond_to_approval(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: ApprovalArgs = parse(args)?;
    let (status, _) = domains
        .deployment
        .approvals()
        .respond(&domains.pool, &args.approval_id, args.response)
        .await
        .map_err(internal_error)?;
    serialize(status)
}

pub(super) async fn project_usage(
    domains: &ServerApplicationDomains,
    args: Value,
) -> Result<Value, ApplicationError> {
    let args: UsageArgs = parse(args).unwrap_or(UsageArgs {
        scope: None,
        project_id: None,
        date_range: None,
    });
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    let cutoff = match args.date_range.as_deref().unwrap_or("7d") {
        "7d" => now_ms - 7 * 24 * 60 * 60 * 1000,
        "30d" => now_ms - 30 * 24 * 60 * 60 * 1000,
        _ => 0,
    };
    let (scope, project_id, project_name, project_uuid) = match args.scope.as_deref() {
        Some("project") => {
            let project_id = args
                .project_id
                .as_deref()
                .and_then(|value| Uuid::parse_str(value).ok())
                .ok_or_else(|| ApplicationError::bad_request("Project scope requires projectId"))?;
            let project = Project::find_by_id(&domains.pool, project_id)
                .await
                .map_err(internal_error)?
                .ok_or_else(|| ApplicationError::not_found("project not found"))?;
            (
                "project".to_string(),
                project.id.to_string(),
                project.name,
                Some(project.id),
            )
        }
        Some("global") | None => (
            "global".to_string(),
            "global".to_string(),
            "全局".to_string(),
            None,
        ),
        Some(other) => {
            return Err(ApplicationError::bad_request(format!(
                "Unsupported usage scope: {other}"
            )));
        }
    };
    serialize(
        conversations::assemble_project_usage_statistics(
            &domains.pool,
            scope,
            project_id,
            project_name,
            project_uuid,
            cutoff,
            now_ms,
        )
        .await
        .map_err(internal_error)?,
    )
}
