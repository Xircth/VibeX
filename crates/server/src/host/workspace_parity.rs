use std::{collections::HashMap, path::PathBuf};

use agents::{
    AgentContentBlock, AgentId, AgentSessionId, EnsureAgentSessionInput, SendAgentPromptInput,
};
use application::{ApplicationError, DomainCommand};
use db::models::{
    execution_process::{ExecutionProcess, ExecutionProcessRunReason},
    image::TaskImage,
    merge::{Merge, MergeStatus, PrMerge, PullRequestInfo},
    project_repo::ProjectRepo,
    repo::{Repo, RepoError},
    session::{CreateSession, Session, SessionStatus},
    task::{CreateTask, Task, TaskStatus, TaskWithAttemptStatus},
    workspace::{CreateWorkspace, Workspace},
    workspace_repo::{CreateWorkspaceRepo, WorkspaceRepo},
};
use deployment::Deployment;
use executors::profile::ExecutorProfileId;
use git::{GitCliError, GitRemote, GitServiceError};
use git2::BranchType;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use services::services::{
    container_actions,
    git_host::{CreatePrRequest, GitHostError, GitHostProvider, GitHostService, ProviderKind},
};
use uuid::Uuid;

use crate::domains::{ServerApplicationDomains, internal_error, parse, serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceIdArgs {
    workspace_id: Uuid,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreatePrArgs {
    workspace_id: Uuid,
    title: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    target_branch: Option<String>,
    #[serde(default)]
    draft: Option<bool>,
    repo_id: Uuid,
    #[serde(default)]
    auto_generate_description: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRepoIdArgs {
    workspace_id: Uuid,
    repo_id: Uuid,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateWorkspaceFromPrRequest {
    repo_id: Uuid,
    pr_number: i64,
    pr_title: String,
    pr_url: String,
    head_branch: String,
    base_branch: String,
    run_setup: bool,
    #[serde(default)]
    remote_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateAndStartTaskRequest {
    task: CreateTask,
    executor_profile_id: ExecutorProfileId,
    repos: Vec<WorkspaceRepoSpec>,
    #[serde(default = "default_use_worktree")]
    use_worktree: bool,
}

fn default_use_worktree() -> bool {
    true
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRepoSpec {
    repo_id: Uuid,
    target_branch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BranchStatus {
    pub commits_behind: Option<usize>,
    pub commits_ahead: Option<usize>,
    pub has_uncommitted_changes: Option<bool>,
    pub head_oid: Option<String>,
    pub uncommitted_count: Option<usize>,
    pub untracked_count: Option<usize>,
    pub target_branch_name: String,
    pub remote_commits_behind: Option<usize>,
    pub remote_commits_ahead: Option<usize>,
    pub merges: Vec<Merge>,
    pub is_rebase_in_progress: bool,
    pub conflict_op: Option<git::ConflictOp>,
    pub conflicted_files: Vec<String>,
    pub is_target_remote: bool,
}

#[derive(Debug, Clone, Serialize)]
struct RepoBranchStatus {
    pub repo_id: Uuid,
    pub repo_name: String,
    #[serde(flatten)]
    pub status: BranchStatus,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum RunScriptError {
    NoScriptConfigured,
    ProcessAlreadyRunning,
}

#[derive(Debug, Serialize)]
struct RunScriptResult {
    pub process: Option<ExecutionProcess>,
    pub error: Option<RunScriptError>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum PrError {
    CliNotInstalled { provider: ProviderKind },
    CliNotLoggedIn { provider: ProviderKind },
    GitCliNotLoggedIn,
    GitCliNotInstalled,
    TargetBranchNotFound { branch: String },
    UnsupportedProvider,
}

#[derive(Debug, Serialize)]
struct CreatePrResult {
    pub url: Option<String>,
    pub error: Option<PrError>,
}

#[derive(Debug, Serialize)]
struct AttachPrResponse {
    pub pr_attached: bool,
    pub pr_url: Option<String>,
    pub pr_number: Option<i64>,
    pub pr_status: Option<MergeStatus>,
}

#[derive(Debug, Serialize)]
struct AttachPrResult {
    pub response: Option<AttachPrResponse>,
    pub error: Option<PrError>,
}

#[derive(Debug, Serialize)]
struct CreateWorkspaceFromPrResponse {
    pub workspace: Workspace,
    pub task: Task,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum CreateFromPrError {
    PrNotFound,
    BranchFetchFailed { message: String },
    CliNotInstalled { provider: ProviderKind },
    AuthFailed { message: String },
    UnsupportedProvider,
    RepoNotInProject,
}

#[derive(Debug, Serialize)]
struct CreateFromPrResult {
    pub response: Option<CreateWorkspaceFromPrResponse>,
    pub error: Option<CreateFromPrError>,
}

impl ServerApplicationDomains {
    pub(crate) async fn workspace_branch_status_all(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let args: WorkspaceIdArgs = parse(args)?;
        let workspace = self.require_workspace(args.workspace_id).await?;
        let repositories = WorkspaceRepo::find_repos_for_workspace(&self.pool, workspace.id)
            .await
            .map_err(internal_error)?;
        let workspace_repos = WorkspaceRepo::find_by_workspace_id(&self.pool, workspace.id)
            .await
            .map_err(internal_error)?;
        let target_branches: HashMap<_, _> = workspace_repos
            .iter()
            .map(|row| (row.repo_id, row.target_branch.clone()))
            .collect();
        let container_ref = self
            .deployment
            .container()
            .ensure_container_exists(&workspace)
            .await
            .map_err(internal_error)?;
        let workspace_dir = PathBuf::from(&container_ref);
        let all_merges = Merge::find_by_workspace_id(&self.pool, workspace.id)
            .await
            .map_err(internal_error)?;
        let mut merges_by_repo: HashMap<Uuid, Vec<Merge>> = HashMap::new();
        for merge in all_merges {
            let repo_id = match &merge {
                Merge::Direct(direct) => direct.repo_id,
                Merge::Pr(pr) => pr.repo_id,
            };
            merges_by_repo.entry(repo_id).or_default().push(merge);
        }

        let mut results = Vec::with_capacity(repositories.len());
        for repo in repositories {
            let Some(target_branch) = target_branches.get(&repo.id).cloned() else {
                continue;
            };
            let repo_merges = merges_by_repo.get(&repo.id).cloned().unwrap_or_default();
            let worktree_path = workspace
                .repo_path(&repo)
                .unwrap_or_else(|| workspace_dir.clone());
            let git = self.deployment.git().clone();
            let status = tokio::task::block_in_place(|| {
                branch_status_for_repo(
                    &git,
                    &workspace,
                    &repo,
                    &worktree_path,
                    &target_branch,
                    repo_merges,
                )
            })?;
            results.push(RepoBranchStatus {
                repo_id: repo.id,
                repo_name: repo.name,
                status,
            });
        }
        serialize(results)
    }

    pub(crate) async fn run_workspace_script(
        &self,
        command: DomainCommand,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let args: WorkspaceIdArgs = parse(args)?;
        let workspace = self.require_workspace(args.workspace_id).await?;
        let reason = match command {
            DomainCommand::WorkspaceRunSetupScript => ExecutionProcessRunReason::SetupScript,
            DomainCommand::WorkspaceRunCleanupScript => ExecutionProcessRunReason::CleanupScript,
            DomainCommand::WorkspaceRunArchiveScript => ExecutionProcessRunReason::ArchiveScript,
            _ => {
                return Err(ApplicationError::internal(
                    "workspace script command is not a script runner",
                ));
            }
        };
        if ExecutionProcess::has_running_non_dev_server_processes_for_workspace(
            &self.pool,
            workspace.id,
        )
        .await
        .map_err(internal_error)?
        {
            return serialize(RunScriptResult {
                process: None,
                error: Some(RunScriptError::ProcessAlreadyRunning),
            });
        }
        self.deployment
            .container()
            .ensure_container_exists(&workspace)
            .await
            .map_err(internal_error)?;
        let repos = WorkspaceRepo::find_repos_for_workspace(&self.pool, workspace.id)
            .await
            .map_err(internal_error)?;
        let executor_action = match command {
            DomainCommand::WorkspaceRunSetupScript => {
                container_actions::setup_actions_for_repos(&repos)
            }
            DomainCommand::WorkspaceRunCleanupScript => {
                container_actions::cleanup_actions_for_repos(&repos)
            }
            DomainCommand::WorkspaceRunArchiveScript => {
                container_actions::archive_actions_for_repos(&repos)
            }
            _ => None,
        };
        let Some(executor_action) = executor_action else {
            return serialize(RunScriptResult {
                process: None,
                error: Some(RunScriptError::NoScriptConfigured),
            });
        };
        let session = ensure_workspace_session(&self.pool, workspace.id).await?;
        let process = self
            .deployment
            .container()
            .start_execution(&workspace, &session, &executor_action, &reason)
            .await
            .map_err(internal_error)?;
        serialize(RunScriptResult {
            process: Some(process),
            error: None,
        })
    }

    pub(crate) async fn create_workspace_pr_host(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let args: CreatePrArgs = parse(args)?;
        let workspace = self.require_workspace(args.workspace_id).await?;
        let workspace_repo =
            WorkspaceRepo::find_by_workspace_and_repo_id(&self.pool, workspace.id, args.repo_id)
                .await
                .map_err(internal_error)?
                .ok_or(RepoError::NotFound)
                .map_err(internal_error)?;
        let repo = Repo::find_by_id(&self.pool, workspace_repo.repo_id)
            .await
            .map_err(internal_error)?
            .ok_or(RepoError::NotFound)
            .map_err(internal_error)?;
        let target = args
            .target_branch
            .clone()
            .unwrap_or_else(|| workspace_repo.target_branch.clone());
        let container_ref = self
            .deployment
            .container()
            .ensure_container_exists(&workspace)
            .await
            .map_err(internal_error)?;
        let workspace_path = PathBuf::from(&container_ref);
        let worktree_path = workspace
            .repo_path(&repo)
            .unwrap_or_else(|| workspace_path.clone());
        let git = self.deployment.git();
        let push_remote = git
            .resolve_remote_for_branch(&repo.path, &workspace.branch)
            .map_err(internal_error)?;
        let (target_remote, base_branch) =
            match git.get_remote_from_branch_name(&repo.path, &target) {
                Ok(remote) => {
                    let branch = target
                        .strip_prefix(&format!("{}/", remote.name))
                        .unwrap_or(&target);
                    (remote, branch.to_string())
                }
                Err(_) => (push_remote.clone(), target.clone()),
            };
        match git.check_remote_branch_exists(&repo.path, &target_remote.url, &base_branch) {
            Ok(false) => {
                return serialize(CreatePrResult {
                    url: None,
                    error: Some(PrError::TargetBranchNotFound { branch: target }),
                });
            }
            Err(GitServiceError::GitCLI(GitCliError::AuthFailed(_))) => {
                return serialize(CreatePrResult {
                    url: None,
                    error: Some(PrError::GitCliNotLoggedIn),
                });
            }
            Err(GitServiceError::GitCLI(GitCliError::NotAvailable)) => {
                return serialize(CreatePrResult {
                    url: None,
                    error: Some(PrError::GitCliNotInstalled),
                });
            }
            Err(error) => return Err(internal_error(error)),
            Ok(true) => {}
        }
        if let Err(error) = git.push_to_remote(&worktree_path, &workspace.branch, false) {
            return match error {
                GitServiceError::GitCLI(GitCliError::AuthFailed(_)) => serialize(CreatePrResult {
                    url: None,
                    error: Some(PrError::GitCliNotLoggedIn),
                }),
                GitServiceError::GitCLI(GitCliError::NotAvailable) => serialize(CreatePrResult {
                    url: None,
                    error: Some(PrError::GitCliNotInstalled),
                }),
                other => Err(internal_error(other)),
            };
        }
        let git_host = match GitHostService::from_url(&target_remote.url) {
            Ok(host) => host,
            Err(GitHostError::UnsupportedProvider) => {
                return serialize(CreatePrResult {
                    url: None,
                    error: Some(PrError::UnsupportedProvider),
                });
            }
            Err(GitHostError::CliNotInstalled { provider }) => {
                return serialize(CreatePrResult {
                    url: None,
                    error: Some(PrError::CliNotInstalled { provider }),
                });
            }
            Err(error) => return Err(internal_error(error)),
        };
        let provider = git_host.provider_kind();
        let mut title = args.title;
        let mut body = args.body;
        if args.auto_generate_description.unwrap_or(false) {
            let task = workspace
                .parent_task(&self.pool)
                .await
                .map_err(internal_error)?;
            let remote_base = format!("{}/{}", target_remote.name, base_branch);
            match generate_pr_description_host(
                self,
                task.as_ref().map(|task| task.title.clone()),
                task.as_ref().and_then(|task| task.description.clone()),
                &worktree_path,
                &base_branch,
                &workspace.branch,
                &[remote_base, base_branch.clone()],
            )
            .await
            {
                Ok(generated) => {
                    title = generated.0;
                    body = Some(generated.1);
                }
                Err(error) => tracing::warn!(%error, "PR description generation failed"),
            }
        }
        let pr_request = CreatePrRequest {
            title: title.clone(),
            body: body.clone(),
            head_branch: workspace.branch.clone(),
            base_branch: base_branch.clone(),
            draft: args.draft,
            head_repo_url: Some(push_remote.url.clone()),
        };
        match git_host
            .create_pr(&repo.path, &target_remote.url, &pr_request)
            .await
        {
            Ok(pr_info) => {
                if let Err(error) = Merge::create_pr(
                    &self.pool,
                    workspace.id,
                    workspace_repo.repo_id,
                    &base_branch,
                    pr_info.number,
                    &pr_info.url,
                )
                .await
                {
                    tracing::error!("Failed to update workspace PR status: {error}");
                }
                if let Err(error) = utils::browser::open_browser(&pr_info.url).await {
                    tracing::warn!("Failed to open PR in browser: {error}");
                }
                serialize(CreatePrResult {
                    url: Some(pr_info.url),
                    error: None,
                })
            }
            Err(error) => match &error {
                GitHostError::CliNotInstalled { provider } => serialize(CreatePrResult {
                    url: None,
                    error: Some(PrError::CliNotInstalled {
                        provider: *provider,
                    }),
                }),
                GitHostError::AuthFailed(_) => serialize(CreatePrResult {
                    url: None,
                    error: Some(PrError::CliNotLoggedIn { provider }),
                }),
                _ => Err(internal_error(error)),
            },
        }
    }

    pub(crate) async fn attach_workspace_pr_host(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let args: WorkspaceRepoIdArgs = parse(args)?;
        let workspace = self.require_workspace(args.workspace_id).await?;
        let task = workspace
            .parent_task(&self.pool)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| ApplicationError::not_found("Parent task not found"))?;
        let workspace_repo =
            WorkspaceRepo::find_by_workspace_and_repo_id(&self.pool, workspace.id, args.repo_id)
                .await
                .map_err(internal_error)?
                .ok_or(RepoError::NotFound)
                .map_err(internal_error)?;
        let repo = Repo::find_by_id(&self.pool, workspace_repo.repo_id)
            .await
            .map_err(internal_error)?
            .ok_or(RepoError::NotFound)
            .map_err(internal_error)?;
        let merges = Merge::find_by_workspace_and_repo_id(&self.pool, workspace.id, args.repo_id)
            .await
            .map_err(internal_error)?;
        if let Some(Merge::Pr(pr_merge)) = merges.into_iter().next() {
            return serialize(AttachPrResult {
                response: Some(AttachPrResponse {
                    pr_attached: true,
                    pr_url: Some(pr_merge.pr_info.url.clone()),
                    pr_number: Some(pr_merge.pr_info.number),
                    pr_status: Some(pr_merge.pr_info.status.clone()),
                }),
                error: None,
            });
        }
        let git = self.deployment.git();
        let remote = git
            .resolve_remote_for_branch(&repo.path, &workspace_repo.target_branch)
            .map_err(internal_error)?;
        let git_host = match GitHostService::from_url(&remote.url) {
            Ok(host) => host,
            Err(GitHostError::UnsupportedProvider) => {
                return serialize(AttachPrResult {
                    response: None,
                    error: Some(PrError::UnsupportedProvider),
                });
            }
            Err(GitHostError::CliNotInstalled { provider }) => {
                return serialize(AttachPrResult {
                    response: None,
                    error: Some(PrError::CliNotInstalled { provider }),
                });
            }
            Err(error) => return Err(internal_error(error)),
        };
        let provider = git_host.provider_kind();
        let prs = match git_host
            .list_prs_for_branch(&repo.path, &remote.url, &workspace.branch)
            .await
        {
            Ok(prs) => prs,
            Err(GitHostError::CliNotInstalled { provider }) => {
                return serialize(AttachPrResult {
                    response: None,
                    error: Some(PrError::CliNotInstalled { provider }),
                });
            }
            Err(GitHostError::AuthFailed(_)) => {
                return serialize(AttachPrResult {
                    response: None,
                    error: Some(PrError::CliNotLoggedIn { provider }),
                });
            }
            Err(error) => return Err(internal_error(error)),
        };
        if let Some(pr_info) = prs.into_iter().next() {
            let merge = Merge::create_pr(
                &self.pool,
                workspace.id,
                workspace_repo.repo_id,
                &workspace_repo.target_branch,
                pr_info.number,
                &pr_info.url,
            )
            .await
            .map_err(internal_error)?;
            if !matches!(pr_info.status, MergeStatus::Open) {
                Merge::update_status(
                    &self.pool,
                    merge.id,
                    pr_info.status.clone(),
                    pr_info.merge_commit_sha.clone(),
                )
                .await
                .map_err(internal_error)?;
            }
            if matches!(pr_info.status, MergeStatus::Merged) {
                Task::update_status(&self.pool, task.id, TaskStatus::Done)
                    .await
                    .map_err(internal_error)?;
                if !workspace.pinned
                    && let Err(error) = self
                        .deployment
                        .container()
                        .archive_workspace(workspace.id)
                        .await
                {
                    tracing::error!("Failed to archive workspace {}: {error}", workspace.id);
                }
            }
            serialize(AttachPrResult {
                response: Some(AttachPrResponse {
                    pr_attached: true,
                    pr_url: Some(pr_info.url),
                    pr_number: Some(pr_info.number),
                    pr_status: Some(pr_info.status),
                }),
                error: None,
            })
        } else {
            serialize(AttachPrResult {
                response: Some(AttachPrResponse {
                    pr_attached: false,
                    pr_url: None,
                    pr_number: None,
                    pr_status: None,
                }),
                error: None,
            })
        }
    }

    pub(crate) async fn create_workspace_from_pr_host(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let payload: CreateWorkspaceFromPrRequest = parse(args)?;
        let repo = Repo::find_by_id(&self.pool, payload.repo_id)
            .await
            .map_err(internal_error)?
            .ok_or(RepoError::NotFound)
            .map_err(internal_error)?;
        let project_repos = ProjectRepo::find_by_repo_id(&self.pool, payload.repo_id)
            .await
            .map_err(internal_error)?;
        let Some(project_id) = project_repos.first().map(|row| row.project_id) else {
            return serialize(CreateFromPrResult {
                response: None,
                error: Some(CreateFromPrError::RepoNotInProject),
            });
        };
        let remote = match payload.remote_name {
            Some(ref name) => GitRemote {
                url: self
                    .deployment
                    .git()
                    .get_remote_url(&repo.path, name)
                    .map_err(internal_error)?,
                name: name.clone(),
            },
            None => self
                .deployment
                .git()
                .get_default_remote(&repo.path)
                .map_err(internal_error)?,
        };
        let target_branch_ref = format!("{}/{}", remote.name, payload.base_branch);
        let task = Task::create(
            &self.pool,
            &CreateTask {
                project_id,
                title: payload.pr_title.clone(),
                description: Some(format!(
                    "Created from PR #{}: {}",
                    payload.pr_number, payload.pr_url
                )),
                status: Some(TaskStatus::InProgress),
                parent_workspace_id: None,
                image_ids: None,
            },
            Uuid::new_v4(),
        )
        .await
        .map_err(internal_error)?;
        let workspace_id = Uuid::new_v4();
        let mut workspace = Workspace::create(
            &self.pool,
            &CreateWorkspace {
                project_id: task.project_id,
                parent_workspace_id: task.parent_workspace_id,
                branch: target_branch_ref.clone(),
                container_ref: None,
                use_worktree: true,
                agent_working_dir: Some(repo.name.clone()),
            },
            workspace_id,
            task.id,
        )
        .await
        .map_err(internal_error)?;
        WorkspaceRepo::create_many(
            &self.pool,
            workspace.id,
            &[CreateWorkspaceRepo {
                repo_id: payload.repo_id,
                target_branch: target_branch_ref.clone(),
            }],
        )
        .await
        .map_err(internal_error)?;
        let container_ref = self
            .deployment
            .container()
            .ensure_container_exists(&workspace)
            .await
            .map_err(internal_error)?;
        workspace.container_ref = Some(container_ref.clone());
        let worktree_path = workspace
            .repo_path(&repo)
            .unwrap_or_else(|| PathBuf::from(&container_ref));
        let gh = services::services::git_host::github::GhCli::new();
        match gh.get_repo_info(&remote.url, &worktree_path) {
            Ok(repo_info) => {
                if let Err(error) = gh.pr_checkout(
                    &worktree_path,
                    &repo_info.owner,
                    &repo_info.repo_name,
                    payload.pr_number,
                ) {
                    return serialize(CreateFromPrResult {
                        response: None,
                        error: Some(CreateFromPrError::BranchFetchFailed {
                            message: error.to_string(),
                        }),
                    });
                }
                Workspace::update_branch_name(&self.pool, workspace.id, &payload.head_branch)
                    .await
                    .map_err(internal_error)?;
                workspace.branch = payload.head_branch.clone();
            }
            Err(error) => {
                return serialize(CreateFromPrResult {
                    response: None,
                    error: Some(CreateFromPrError::BranchFetchFailed {
                        message: format!("Failed to get repository info: {error}"),
                    }),
                });
            }
        }
        Merge::create_pr(
            &self.pool,
            workspace.id,
            payload.repo_id,
            &format!("{}/{}", remote.name, payload.base_branch),
            payload.pr_number,
            &payload.pr_url,
        )
        .await
        .map_err(internal_error)?;
        if payload.run_setup {
            let repos = WorkspaceRepo::find_repos_for_workspace(&self.pool, workspace.id)
                .await
                .map_err(internal_error)?;
            if let Some(setup_action) = container_actions::setup_actions_for_repos(&repos) {
                let session = ensure_workspace_session(&self.pool, workspace.id).await?;
                if let Err(error) = self
                    .deployment
                    .container()
                    .start_execution(
                        &workspace,
                        &session,
                        &setup_action,
                        &ExecutionProcessRunReason::SetupScript,
                    )
                    .await
                {
                    tracing::error!("Failed to run setup script: {error}");
                }
            }
        }
        let workspace = Workspace::find_by_id(&self.pool, workspace.id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| ApplicationError::not_found("Workspace not found after creation"))?;
        serialize(CreateFromPrResult {
            response: Some(CreateWorkspaceFromPrResponse { workspace, task }),
            error: None,
        })
    }

    pub(crate) async fn create_task_and_start_host(
        &self,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let payload: CreateAndStartTaskRequest = parse(args)?;
        if payload.repos.is_empty() {
            return Err(ApplicationError::bad_request(
                "At least one repository is required",
            ));
        }
        let workspace_repos: Vec<CreateWorkspaceRepo> = payload
            .repos
            .iter()
            .map(|repo| CreateWorkspaceRepo {
                repo_id: repo.repo_id,
                target_branch: repo.target_branch.clone(),
            })
            .collect();
        let primary_repo = if payload.repos.len() == 1 {
            Some(
                Repo::find_by_id(&self.pool, payload.repos[0].repo_id)
                    .await
                    .map_err(internal_error)?
                    .ok_or(RepoError::NotFound)
                    .map_err(internal_error)?,
            )
        } else {
            None
        };
        let reusable_workspace_id = if payload.use_worktree {
            None
        } else {
            WorkspaceRepo::find_reusable_non_worktree_workspace_id(
                &self.pool,
                payload.task.project_id,
                &workspace_repos,
            )
            .await
            .map_err(internal_error)?
        };
        if !payload.use_worktree && reusable_workspace_id.is_none() && payload.repos.len() != 1 {
            return Err(ApplicationError::bad_request(
                "Creating a non-worktree workspace currently requires a single repository unless an existing matching workspace can be reused",
            ));
        }
        let task = Task::create(&self.pool, &payload.task, Uuid::new_v4())
            .await
            .map_err(internal_error)?;
        if let Some(image_ids) = &payload.task.image_ids {
            TaskImage::associate_many_dedup(&self.pool, task.id, image_ids)
                .await
                .map_err(internal_error)?;
        }
        let workspace = if let Some(workspace_id) = reusable_workspace_id {
            Workspace::find_by_id(&self.pool, workspace_id)
                .await
                .map_err(internal_error)?
                .ok_or_else(|| {
                    ApplicationError::not_found(format!("Workspace {workspace_id} not found"))
                })?
        } else {
            let attempt_id = Uuid::new_v4();
            let git_branch_name = if payload.use_worktree {
                self.deployment
                    .container()
                    .git_branch_from_workspace(&attempt_id, &task.title)
                    .await
            } else {
                let repo = primary_repo.as_ref().ok_or_else(|| {
                    ApplicationError::bad_request(
                        "Opening the current branch without a worktree requires one repository",
                    )
                })?;
                self.deployment
                    .git()
                    .get_current_branch(&repo.path)
                    .map_err(internal_error)?
            };
            let agent_working_dir = if payload.repos.len() == 1 {
                let repo = primary_repo
                    .as_ref()
                    .ok_or(RepoError::NotFound)
                    .map_err(internal_error)?;
                match &repo.default_working_dir {
                    Some(subdir) => {
                        if payload.use_worktree {
                            Some(
                                PathBuf::from(&repo.name)
                                    .join(subdir)
                                    .to_string_lossy()
                                    .into_owned(),
                            )
                        } else {
                            Some(subdir.clone())
                        }
                    }
                    None => payload.use_worktree.then(|| repo.name.clone()),
                }
            } else {
                None
            };
            let container_ref = if payload.use_worktree {
                None
            } else {
                Some(
                    primary_repo
                        .as_ref()
                        .ok_or(RepoError::NotFound)
                        .map_err(internal_error)?
                        .path
                        .to_string_lossy()
                        .into_owned(),
                )
            };
            let workspace = Workspace::create(
                &self.pool,
                &CreateWorkspace {
                    project_id: task.project_id,
                    parent_workspace_id: task.parent_workspace_id,
                    branch: git_branch_name,
                    container_ref,
                    use_worktree: payload.use_worktree,
                    agent_working_dir,
                },
                attempt_id,
                task.id,
            )
            .await
            .map_err(internal_error)?;
            WorkspaceRepo::create_many(&self.pool, workspace.id, &workspace_repos)
                .await
                .map_err(internal_error)?;
            Workspace::update(
                &self.pool,
                workspace.id,
                None,
                None,
                Some(task.title.as_str()),
            )
            .await
            .map_err(internal_error)?;
            Workspace::find_by_id(&self.pool, workspace.id)
                .await
                .map_err(internal_error)?
                .ok_or_else(|| {
                    ApplicationError::not_found(format!("Workspace {} not found", workspace.id))
                })?
        };
        let session = Session::create(
            &self.pool,
            &CreateSession {
                executor: Some(payload.executor_profile_id.executor.to_string()),
                agent_id: None,
                task_id: Some(task.id),
                name: Some(task.title.clone()),
                initial_prompt: task.description.clone(),
                status: Some(task_status_to_session_status(&task.status)),
            },
            Uuid::new_v4(),
            workspace.id,
        )
        .await
        .map_err(internal_error)?;
        let started = self
            .start_task_attempt(&workspace, &session, &task, &payload.executor_profile_id)
            .await
            .inspect_err(|error| {
                tracing::error!("Failed to start ACP-native task attempt: {error}")
            })
            .is_ok();
        let task = Task::find_by_id(&self.pool, task.id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| ApplicationError::not_found("Task not found after creation"))?;
        serialize(TaskWithAttemptStatus {
            task,
            has_in_progress_attempt: started,
            last_attempt_failed: false,
            executor: payload.executor_profile_id.executor.to_string(),
        })
    }

    async fn start_task_attempt(
        &self,
        workspace: &Workspace,
        session: &Session,
        task: &Task,
        profile: &ExecutorProfileId,
    ) -> Result<(), ApplicationError> {
        let container_ref = self
            .deployment
            .container()
            .ensure_container_exists(workspace)
            .await
            .map_err(internal_error)?;
        let repos = WorkspaceRepo::find_repos_for_workspace(&self.pool, workspace.id)
            .await
            .map_err(internal_error)?;
        let working_dir = conversations::resolve_absolute_workspace_agent_working_dir(
            workspace,
            &container_ref,
            &repos,
        );
        let additional_directories = conversations::host::resolve_workspace_additional_directories(
            workspace,
            &container_ref,
            &repos,
            &working_dir,
        );
        let agent_id = AgentId::parse(&profile.executor)
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        let launch = self
            .conversations
            .host
            .launch_settings(&self.pool, &agent_id)
            .await
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        let agent_session = self
            .conversations
            .agent_runtime
            .ensure_session(EnsureAgentSessionInput {
                agent_id: agent_id.clone(),
                launch_lock: launch.launch_lock,
                workspace_id: workspace.id,
                working_dir: PathBuf::from(&working_dir),
                additional_directories,
                session_id: AgentSessionId(session.id),
                acp_session_id: session.id.to_string(),
                auto_approve_mode: launch.auto_approve_mode,
                env: launch.env,
                preferences: Default::default(),
            })
            .await
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        self.conversations
            .agent_runtime
            .send_prompt(SendAgentPromptInput {
                connection_id: agent_session.connection_id,
                session_id: agent_session.id,
                blocks: vec![AgentContentBlock::Text {
                    text: session
                        .initial_prompt
                        .clone()
                        .filter(|prompt| !prompt.trim().is_empty())
                        .unwrap_or_else(|| task.to_prompt()),
                }],
                mode_override: None,
                config_overrides: Vec::new(),
            })
            .await
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        Ok(())
    }
}

fn branch_status_for_repo(
    git: &git::GitService,
    workspace: &Workspace,
    repo: &Repo,
    worktree_path: &PathBuf,
    target_branch: &str,
    repo_merges: Vec<Merge>,
) -> Result<BranchStatus, ApplicationError> {
    let head_oid = git.get_head_info(worktree_path).ok().map(|head| head.oid);
    let is_rebase_in_progress = git.is_rebase_in_progress(worktree_path).unwrap_or(false);
    let conflicted_files = git.get_conflicted_files(worktree_path).unwrap_or_default();
    let conflict_op = if conflicted_files.is_empty() {
        None
    } else {
        git.detect_conflict_op(worktree_path).unwrap_or(None)
    };
    let (uncommitted_count, untracked_count) = match git.get_worktree_change_counts(worktree_path) {
        Ok((uncommitted, untracked)) => (Some(uncommitted), Some(untracked)),
        Err(_) => (None, None),
    };
    let target_branch_type = git
        .find_branch_type(&repo.path, target_branch)
        .map_err(internal_error)?;
    let (commits_ahead, commits_behind) = match target_branch_type {
        BranchType::Local => {
            let (ahead, behind) = git
                .get_branch_status(&repo.path, &workspace.branch, target_branch)
                .map_err(internal_error)?;
            (Some(ahead), Some(behind))
        }
        BranchType::Remote => {
            let (ahead, behind) = git
                .get_remote_branch_status(&repo.path, &workspace.branch, Some(target_branch))
                .map_err(internal_error)?;
            (Some(ahead), Some(behind))
        }
    };
    let (remote_ahead, remote_behind) = if let Some(Merge::Pr(PrMerge {
        pr_info: PullRequestInfo {
            status: MergeStatus::Open,
            ..
        },
        ..
    })) = repo_merges.first()
    {
        match git.get_remote_branch_status(&repo.path, &workspace.branch, None) {
            Ok((ahead, behind)) => (Some(ahead), Some(behind)),
            Err(_) => (None, None),
        }
    } else {
        (None, None)
    };
    Ok(BranchStatus {
        commits_ahead,
        commits_behind,
        has_uncommitted_changes: uncommitted_count.map(|count| count > 0),
        head_oid,
        uncommitted_count,
        untracked_count,
        remote_commits_ahead: remote_ahead,
        remote_commits_behind: remote_behind,
        merges: repo_merges,
        target_branch_name: target_branch.to_string(),
        is_rebase_in_progress,
        conflict_op,
        conflicted_files,
        is_target_remote: target_branch_type == BranchType::Remote,
    })
}

async fn ensure_workspace_session(
    pool: &sqlx::SqlitePool,
    workspace_id: Uuid,
) -> Result<Session, ApplicationError> {
    if let Some(session) = Session::find_latest_by_workspace_id(pool, workspace_id)
        .await
        .map_err(internal_error)?
    {
        return Ok(session);
    }
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
        workspace_id,
    )
    .await
    .map_err(internal_error)
}

fn task_status_to_session_status(status: &TaskStatus) -> SessionStatus {
    match status {
        TaskStatus::Todo => SessionStatus::Todo,
        TaskStatus::InProgress => SessionStatus::InProgress,
        TaskStatus::InReview => SessionStatus::InReview,
        TaskStatus::Done | TaskStatus::Cancelled => SessionStatus::Done,
    }
}

async fn generate_pr_description_host(
    domains: &ServerApplicationDomains,
    task_title: Option<String>,
    task_description: Option<String>,
    worktree_path: &std::path::Path,
    base_branch: &str,
    head_branch: &str,
    base_ref_candidates: &[String],
) -> Result<(String, String), ApplicationError> {
    use services::services::pr_description::{
        PrDescriptionContext, build_pr_description_payload, extract_pr_description,
        selected_pr_description_agent, validate_pr_description_request,
    };
    let config = domains.deployment.config().read().await.clone();
    validate_pr_description_request(&config)
        .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
    let agent_id = selected_pr_description_agent(&config)
        .ok_or_else(|| ApplicationError::bad_request("PR description Agent is not configured"))?;
    let agent_id = AgentId::parse(agent_id)
        .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
    let git = git::GitCli::new();
    let base_ref = base_ref_candidates.iter().find(|candidate| {
        git.git(worktree_path, ["rev-parse", "--verify", candidate.as_str()])
            .is_ok()
    });
    let (commit_log, diff_stat, diff) = if let Some(base_ref) = base_ref {
        let range = format!("{base_ref}..HEAD");
        let triple_dot = format!("{base_ref}...HEAD");
        (
            git.git(worktree_path, ["log", "--format=%h %s", &range])
                .unwrap_or_default(),
            git.git(worktree_path, ["diff", "--stat", &triple_dot])
                .unwrap_or_default(),
            git.git(worktree_path, ["diff", &triple_dot])
                .unwrap_or_default(),
        )
    } else {
        (String::new(), String::new(), String::new())
    };
    let prompt_text = build_pr_description_payload(
        &config,
        &PrDescriptionContext {
            task_title,
            task_description,
            base_branch: base_branch.to_string(),
            head_branch: head_branch.to_string(),
            commit_log,
            diff_stat,
            diff,
        },
    )
    .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
    let launch = domains
        .conversations
        .host
        .launch_settings(&domains.pool, &agent_id)
        .await
        .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
    let runtime = &domains.conversations.agent_runtime;
    let events = runtime.subscribe_events();
    let session = runtime
        .ensure_session(EnsureAgentSessionInput {
            agent_id: agent_id.clone(),
            launch_lock: launch.launch_lock,
            workspace_id: Uuid::nil(),
            working_dir: std::env::temp_dir(),
            additional_directories: Vec::new(),
            session_id: AgentSessionId::new(),
            acp_session_id: String::new(),
            auto_approve_mode: launch.auto_approve_mode,
            env: launch.env,
            preferences: Default::default(),
        })
        .await
        .map_err(internal_error)?;
    runtime
        .send_prompt(SendAgentPromptInput {
            connection_id: session.connection_id,
            session_id: session.id,
            blocks: vec![AgentContentBlock::Text { text: prompt_text }],
            mode_override: config.pr_auto_description_mode.clone(),
            config_overrides: config
                .pr_auto_description_session_config
                .iter()
                .map(|(key, value)| agents::events::AgentSessionConfigOverride {
                    key: key.clone(),
                    value: value.clone(),
                })
                .collect(),
        })
        .await
        .map_err(internal_error)?;
    let response_text = match tokio::time::timeout(
        std::time::Duration::from_secs(
            services::services::pr_description::PR_DESCRIPTION_TIMEOUT_SECS,
        ),
        collect_pr_response_text(events, session.id, session.connection_id),
    )
    .await
    {
        Ok(result) => result?,
        Err(_) => {
            let _ = runtime.disconnect(session.connection_id).await;
            return Err(ApplicationError::internal("PR description Agent timed out"));
        }
    };
    let _ = runtime.disconnect(session.connection_id).await;
    extract_pr_description(&response_text)
        .map(|draft| (draft.title, draft.body))
        .ok_or_else(|| {
            ApplicationError::internal("PR description Agent did not return Title and Body fields")
        })
}

async fn collect_pr_response_text(
    mut events: tokio::sync::broadcast::Receiver<agents::events::AgentEventEnvelope>,
    session_id: AgentSessionId,
    connection_id: agents::AgentConnectionId,
) -> Result<String, ApplicationError> {
    use agents::events::AgentEvent;
    use tokio::sync::broadcast::error::RecvError;
    let mut response_text = String::new();
    loop {
        let envelope = match events.recv().await {
            Ok(envelope) => envelope,
            Err(RecvError::Lagged(_)) => continue,
            Err(RecvError::Closed) => {
                return Err(ApplicationError::internal(
                    "PR description failed: Agent event stream closed",
                ));
            }
        };
        if envelope.session_id != Some(session_id) {
            continue;
        }
        match envelope.event {
            AgentEvent::MessageChunk {
                content: AgentContentBlock::Text { text },
            } => response_text.push_str(&text),
            AgentEvent::PromptFinished { .. } => return Ok(response_text),
            AgentEvent::Error { error } => {
                return Err(ApplicationError::internal(format!(
                    "PR description Agent failed: {}",
                    error.message
                )));
            }
            _ => {}
        }
        let _ = connection_id;
    }
}
