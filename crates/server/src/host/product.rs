use std::path::{Path, PathBuf};

use agents::{
    AgentContentBlock, AgentId, AgentSessionId, EnsureAgentSessionInput, SendAgentPromptInput,
    terminal::agent_terminal_registry,
};
use application::{ApplicationError, DomainCommand};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use db::models::{
    attention as attention_model,
    execution_process::{ExecutionProcess, ExecutionProcessStatus},
    repo::{Repo, UpdateRepo},
    scratch::{CreateScratch, Scratch, ScratchType, UpdateScratch},
    session::{CreateSession, Session, SessionStatus},
    tag::{CreateTag, Tag, UpdateTag},
    task::{CreateTask, Task, TaskStatus},
    workspace::{CreateWorkspace, Workspace},
    workspace_repo::{CreateWorkspaceRepo, WorkspaceRepo},
};
use deployment::Deployment;
use serde::Deserialize;
use serde_json::{Value, json};
use services::services::{
    agent_plan_usage::AgentPlanUsageApplicationService,
    git_host::{GitHostProvider, GitHostService},
    settings_store::{merge_object_section, read_section},
    worktree_settings::{load_project_settings, save_project_settings},
};
use uuid::Uuid;

use crate::{
    domains::{ServerApplicationDomains, internal_error, parse, serialize},
    host_ops::{RepoIdArgs, WorkspaceRepoArgs},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceIdArgs {
    workspace_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteWorkspaceArgs {
    workspace_id: Uuid,
    #[serde(default)]
    delete_branches: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PushWorkspaceArgs {
    workspace_id: Uuid,
    #[serde(default)]
    repo_id: Option<Uuid>,
    #[serde(default)]
    force: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RebaseWorkspaceArgs {
    workspace_id: Uuid,
    #[serde(default)]
    repo_id: Option<Uuid>,
    #[serde(default)]
    old_base_branch: Option<String>,
    #[serde(default)]
    new_base_branch: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StashWorkspaceArgs {
    workspace_id: Uuid,
    #[serde(default)]
    repo_id: Option<Uuid>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    include_untracked: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TagListArgs {
    #[serde(default)]
    search: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdArgs {
    #[serde(alias = "taskId", alias = "tagId")]
    id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRepoSpec {
    #[serde(alias = "repo_id")]
    repo_id: Uuid,
    #[serde(alias = "target_branch")]
    target_branch: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExecutorProfileArg {
    executor: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateWorkspaceArgs {
    #[serde(alias = "task_id")]
    task_id: Uuid,
    repos: Vec<WorkspaceRepoSpec>,
    #[serde(default, alias = "executor_profile_id")]
    executor_profile_id: Option<ExecutorProfileArg>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateWorkspaceArgs {
    workspace_id: Uuid,
    archived: Option<bool>,
    pinned: Option<bool>,
    name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StashIndexArgs {
    workspace_id: Uuid,
    repo_id: Option<Uuid>,
    index: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameBranchArgs {
    workspace_id: Uuid,
    repo_id: Option<Uuid>,
    #[serde(alias = "newBranchName")]
    new_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TargetBranchArgs {
    workspace_id: Uuid,
    repo_id: Option<Uuid>,
    #[serde(alias = "newTargetBranch")]
    target_branch: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScratchArgs {
    scratch_type: ScratchType,
    id: Uuid,
    #[serde(default)]
    payload: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateTagArgs {
    #[serde(alias = "tagName")]
    tag_name: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateTagArgs {
    #[serde(alias = "tagId")]
    id: Uuid,
    #[serde(default, alias = "tagName")]
    tag_name: Option<String>,
    #[serde(default)]
    content: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateTaskArgs {
    #[serde(alias = "taskId")]
    id: Uuid,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    status: Option<TaskStatus>,
    #[serde(default)]
    parent_workspace_id: Option<Uuid>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateRepoArgs {
    repo_id: Uuid,
    payload: UpdateRepo,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteArgs {
    repo_id: Uuid,
    name: Option<String>,
    url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommitArgs {
    repo_id: Option<Uuid>,
    workspace_id: Option<Uuid>,
    sha: Option<String>,
    commit_hash: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentIdArgs {
    agent_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathArgs {
    path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkflowSourceArgs {
    path: String,
    #[serde(default, alias = "contents")]
    content: Option<String>,
    expected_revision: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreferencesArgs {
    #[serde(default)]
    preferences: serde_json::Map<String, Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSettingsArgs {
    project_id: Uuid,
    #[serde(default)]
    settings: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepoSearchArgs {
    repo_id: Uuid,
    q: String,
    #[serde(default)]
    mode: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepoIssuesArgs {
    repo_id: Uuid,
    issue_state: Option<String>,
    remote: Option<String>,
}

impl ServerApplicationDomains {
    pub(crate) async fn product_command(
        &self,
        command: DomainCommand,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        match command {
            DomainCommand::WorkspaceCreate => self.create_workspace(args).await,
            DomainCommand::WorkspaceUpdate => self.update_workspace(args).await,
            DomainCommand::WorkspaceDelete => self.delete_workspace(args).await,
            DomainCommand::WorkspaceMarkSeen => {
                let args: WorkspaceIdArgs = parse(args)?;
                Workspace::touch(&self.pool, args.workspace_id)
                    .await
                    .map_err(internal_error)?;
                Ok(Value::Null)
            }
            DomainCommand::WorkspaceChildren => {
                let args: WorkspaceIdArgs = parse(args)?;
                let workspace = self.require_workspace(args.workspace_id).await?;
                serialize(
                    Task::find_relationships_for_workspace(&self.pool, &workspace)
                        .await
                        .map_err(internal_error)?,
                )
            }
            DomainCommand::WorkspaceBranchStatus
            | DomainCommand::WorkspaceCommitHistory
            | DomainCommand::WorkspaceCommitGraph
            | DomainCommand::WorkspaceCommitDiffs => self.workspace_git_read(command, args).await,
            DomainCommand::WorkspacePush => {
                let args: PushWorkspaceArgs = parse(args)?;
                let force = args.force.unwrap_or(false);
                self.workspace_git_write(
                    json!({
                        "workspaceId": args.workspace_id,
                        "repoId": args.repo_id,
                    }),
                    move |git, path, workspace, _repo, _target| {
                        git.push_to_remote(path, &workspace.branch, force)?;
                        Ok(())
                    },
                )
                .await
            }
            DomainCommand::WorkspacePull => {
                self.workspace_git_write(args, |git, path, _, _, _| git.pull(path).map(|_| ()))
                    .await
            }
            DomainCommand::WorkspaceFetch => {
                self.workspace_git_write(args, |git, path, _, _, _| git.fetch_all(path))
                    .await
            }
            DomainCommand::WorkspaceMerge => {
                self.workspace_git_write(args, |git, path, workspace, repo, target| {
                    git.merge_changes(
                        &repo.path,
                        path,
                        &workspace.branch,
                        target,
                        &format!("Merge {}", workspace.branch),
                    )
                    .map(|_| ())
                })
                .await
            }
            DomainCommand::WorkspaceRebase => self.rebase_workspace(args).await,
            DomainCommand::WorkspaceRebaseBack => {
                self.workspace_git_write(args, |git, path, workspace, repo, target| {
                    git.rebase_back(&repo.path, path, &workspace.branch, target, "")
                        .map(|_| ())
                })
                .await
            }
            DomainCommand::WorkspaceContinueRebase => {
                self.workspace_git_write(args, |git, path, _, _, _| git.continue_rebase(path))
                    .await
            }
            DomainCommand::WorkspaceAbortConflicts => {
                self.workspace_git_write(args, |git, path, _, _, _| {
                    if git.is_rebase_in_progress(path).unwrap_or(false) {
                        git.abort_rebase(path)
                    } else {
                        git::GitCli::new()
                            .abort_merge(path)
                            .map_err(git::GitServiceError::from)
                    }
                })
                .await
            }
            DomainCommand::WorkspaceStash => {
                let args: StashWorkspaceArgs = parse(args)?;
                let message = args.message.clone();
                let include_untracked = args.include_untracked.unwrap_or(true);
                let stashed = {
                    let path = self
                        .primary_worktree(args.workspace_id, args.repo_id)
                        .await?;
                    let git = self.deployment.git().clone();
                    tokio::task::spawn_blocking(move || {
                        git.stash_push(&path, message.as_deref(), include_untracked)
                    })
                    .await
                    .map_err(|error| ApplicationError::internal(error.to_string()))?
                    .map_err(internal_error)?
                };
                serialize(stashed)
            }
            DomainCommand::WorkspaceStashList => {
                let path = self.primary_worktree_from_value(&args).await?;
                self.git_read(path, git::GitService::stash_list).await
            }
            DomainCommand::WorkspaceStashApply => {
                self.stash_op(args, git::GitService::stash_apply).await
            }
            DomainCommand::WorkspaceStashPop => {
                self.stash_op(args, git::GitService::stash_pop).await
            }
            DomainCommand::WorkspaceStashDrop => {
                self.stash_op(args, git::GitService::stash_drop).await
            }
            DomainCommand::WorkspaceRenameBranch => {
                let args: RenameBranchArgs = parse(args)?;
                let workspace = self.require_workspace(args.workspace_id).await?;
                let path = self
                    .primary_worktree(args.workspace_id, args.repo_id)
                    .await?;
                let old_name = workspace.branch.clone();
                self.git_write(path, |git, path| {
                    git.rename_local_branch(path, &old_name, &args.new_name)
                })
                .await?;
                Workspace::update_branch_name(&self.pool, args.workspace_id, &args.new_name)
                    .await
                    .map_err(internal_error)?;
                serialize(json!({ "new_branch": args.new_name }))
            }
            DomainCommand::WorkspaceChangeTargetBranch => {
                let args: TargetBranchArgs = parse(args)?;
                let workspace = self.require_workspace(args.workspace_id).await?;
                let repo_id = match args.repo_id {
                    Some(repo_id) => repo_id,
                    None => self.primary_repo(args.workspace_id).await?.id,
                };
                let repo = Repo::find_by_id(&self.pool, repo_id)
                    .await
                    .map_err(internal_error)?
                    .ok_or_else(|| ApplicationError::not_found("repository not found"))?;
                if !self
                    .deployment
                    .git()
                    .check_branch_exists(&repo.path, &args.target_branch)
                    .map_err(internal_error)?
                {
                    return Err(ApplicationError::bad_request(format!(
                        "Branch '{}' does not exist in repository '{}'",
                        args.target_branch, repo.name
                    )));
                }
                WorkspaceRepo::update_target_branch(
                    &self.pool,
                    args.workspace_id,
                    repo_id,
                    &args.target_branch,
                )
                .await
                .map_err(internal_error)?;
                let status = self
                    .deployment
                    .git()
                    .get_branch_status(&repo.path, &workspace.branch, &args.target_branch)
                    .map_err(internal_error)?;
                serialize(json!({
                    "repoId": repo_id,
                    "newTargetBranch": args.target_branch,
                    "status": status,
                }))
            }
            DomainCommand::AttentionInboxList => self.attention_inbox().await,
            DomainCommand::ScratchGet => {
                let args: ScratchArgs = parse(args)?;
                serialize(
                    Scratch::find_by_id(&self.pool, args.id, &args.scratch_type)
                        .await
                        .map_err(internal_error)?
                        .ok_or_else(|| ApplicationError::not_found("scratch not found"))?,
                )
            }
            DomainCommand::ScratchCreate => {
                let args: ScratchArgs = parse(args)?;
                let payload: CreateScratch = parse(args.payload.unwrap_or(Value::Null))?;
                serialize(
                    Scratch::create(&self.pool, args.id, &payload)
                        .await
                        .map_err(internal_error)?,
                )
            }
            DomainCommand::ScratchUpdate => {
                let args: ScratchArgs = parse(args)?;
                let payload: UpdateScratch = parse(args.payload.unwrap_or(Value::Null))?;
                serialize(
                    Scratch::update(&self.pool, args.id, &args.scratch_type, &payload)
                        .await
                        .map_err(internal_error)?,
                )
            }
            DomainCommand::ScratchDelete => {
                let args: ScratchArgs = parse(args)?;
                Scratch::delete(&self.pool, args.id, &args.scratch_type)
                    .await
                    .map_err(internal_error)?;
                Ok(Value::Null)
            }
            DomainCommand::TagList => {
                let args: TagListArgs = parse(args).unwrap_or(TagListArgs { search: None });
                let tags = Tag::find_all(&self.pool).await.map_err(internal_error)?;
                let Some(search) = args.search.filter(|value| !value.trim().is_empty()) else {
                    return serialize(tags);
                };
                let needle = search.to_lowercase();
                serialize(
                    tags.into_iter()
                        .filter(|tag| {
                            tag.tag_name.to_lowercase().contains(&needle)
                                || tag.content.to_lowercase().contains(&needle)
                        })
                        .collect::<Vec<_>>(),
                )
            }
            DomainCommand::TagCreate => {
                let args: CreateTagArgs = parse(args)?;
                serialize(
                    Tag::create(
                        &self.pool,
                        &CreateTag {
                            tag_name: args.tag_name,
                            content: args.content,
                        },
                    )
                    .await
                    .map_err(internal_error)?,
                )
            }
            DomainCommand::TagUpdate => {
                let args: UpdateTagArgs = parse(args)?;
                serialize(
                    Tag::update(
                        &self.pool,
                        args.id,
                        &UpdateTag {
                            tag_name: args.tag_name,
                            content: args.content,
                        },
                    )
                    .await
                    .map_err(internal_error)?,
                )
            }
            DomainCommand::TagDelete => {
                let args: IdArgs = parse(args)?;
                Tag::delete(&self.pool, args.id)
                    .await
                    .map_err(internal_error)?;
                Ok(Value::Null)
            }
            DomainCommand::TaskGet => {
                let args: IdArgs = parse(args)?;
                serialize(
                    Task::find_by_id(&self.pool, args.id)
                        .await
                        .map_err(internal_error)?
                        .ok_or_else(|| ApplicationError::not_found("task not found"))?,
                )
            }
            DomainCommand::TaskCreate => {
                let payload: CreateTask = parse_payload_or_value(args)?;
                let task = Task::create(&self.pool, &payload, Uuid::new_v4())
                    .await
                    .map_err(internal_error)?;
                serialize(task)
            }
            DomainCommand::TaskCreateAndStart => self.create_task_and_start_host(args).await,
            DomainCommand::TaskUpdate => {
                let args: UpdateTaskArgs = parse(args)?;
                let existing = Task::find_by_id(&self.pool, args.id)
                    .await
                    .map_err(internal_error)?
                    .ok_or_else(|| ApplicationError::not_found("task not found"))?;
                serialize(
                    Task::update(
                        &self.pool,
                        args.id,
                        existing.project_id,
                        args.title.unwrap_or(existing.title),
                        args.description.or(existing.description),
                        args.status.unwrap_or(existing.status),
                        args.parent_workspace_id.or(existing.parent_workspace_id),
                    )
                    .await
                    .map_err(internal_error)?,
                )
            }
            DomainCommand::TaskDelete => {
                let args: IdArgs = parse(args)?;
                Task::delete(&self.pool, args.id)
                    .await
                    .map_err(internal_error)?;
                Ok(Value::Null)
            }
            DomainCommand::RepoUpdate => {
                let args: UpdateRepoArgs = parse(args)?;
                serialize(
                    Repo::update(&self.pool, args.repo_id, &args.payload)
                        .await
                        .map_err(internal_error)?,
                )
            }
            DomainCommand::RepoPush => {
                self.repo_git_write(args, |git, path| {
                    let branch = current_branch(path)?;
                    git.push_to_remote(path, &branch, false)
                })
                .await
            }
            DomainCommand::RepoPull => {
                self.repo_git_write(args, |git, path| git.pull(path).map(|_| ()))
                    .await
            }
            DomainCommand::RepoFetch => {
                self.repo_git_write(args, |git, path| git.fetch_all(path))
                    .await
            }
            DomainCommand::RepoRemotes => {
                let args: RepoIdArgs = parse(args)?;
                self.git_read(self.repo_path(args).await?, git::GitService::list_remotes)
                    .await
            }
            DomainCommand::RepoAddRemote => {
                let args: RemoteArgs = parse(args)?;
                let path = self
                    .repo_path(RepoIdArgs {
                        repo_id: args.repo_id,
                    })
                    .await?;
                git::GitCli::new()
                    .git(
                        &path,
                        [
                            "remote",
                            "add",
                            args.name.as_deref().unwrap_or("origin"),
                            args.url.as_deref().unwrap_or_default(),
                        ],
                    )
                    .map_err(internal_error)?;
                Ok(Value::Null)
            }
            DomainCommand::RepoRemoveRemote => {
                let args: RemoteArgs = parse(args)?;
                let path = self
                    .repo_path(RepoIdArgs {
                        repo_id: args.repo_id,
                    })
                    .await?;
                git::GitCli::new()
                    .git(
                        &path,
                        ["remote", "remove", args.name.as_deref().unwrap_or("origin")],
                    )
                    .map_err(internal_error)?;
                Ok(Value::Null)
            }
            DomainCommand::RepoSetRemoteUrl => {
                let args: RemoteArgs = parse(args)?;
                let path = self
                    .repo_path(RepoIdArgs {
                        repo_id: args.repo_id,
                    })
                    .await?;
                git::GitCli::new()
                    .git(
                        &path,
                        [
                            "remote",
                            "set-url",
                            args.name.as_deref().unwrap_or("origin"),
                            args.url.as_deref().unwrap_or_default(),
                        ],
                    )
                    .map_err(internal_error)?;
                Ok(Value::Null)
            }
            DomainCommand::RepoCommitDetail | DomainCommand::RepoCommitDiffs => {
                self.commit_read(args).await
            }
            DomainCommand::RepoSearch => {
                let args: RepoSearchArgs = parse(args)?;
                let path = self
                    .repo_path(RepoIdArgs {
                        repo_id: args.repo_id,
                    })
                    .await?;
                serialize(
                    self.deployment
                        .file_search()
                        .search_repo(
                            &path,
                            &args.q,
                            match args.mode.as_deref() {
                                Some("settings") => {
                                    services::services::file_search::SearchMode::Settings
                                }
                                _ => services::services::file_search::SearchMode::TaskForm,
                            },
                        )
                        .await
                        .map_err(ApplicationError::internal)?,
                )
            }
            DomainCommand::RepoIssues => {
                let args: RepoIssuesArgs = parse(args)?;
                let path = self
                    .repo_path(RepoIdArgs {
                        repo_id: args.repo_id,
                    })
                    .await?;
                let remote = repo_remote(&self.deployment.git(), &path, args.remote.as_deref())?;
                let state_filter = args.issue_state.unwrap_or_else(|| "open".to_string());
                let remote_url = remote.url.clone();
                let issues = tokio::task::spawn_blocking(move || {
                    let cli = services::services::git_host::github::GhCli::new();
                    let info = cli
                        .get_repo_info(&remote_url, &path)
                        .map_err(|error| error.to_string())?;
                    cli.list_issues(&info.owner, &info.repo_name, &state_filter)
                        .map_err(|error| error.to_string())
                })
                .await
                .map_err(internal_error)?
                .map_err(internal_error)?;
                serialize(issues)
            }
            DomainCommand::RepoOpenPrs => {
                let args: RepoIssuesArgs = parse(args)?;
                let path = self
                    .repo_path(RepoIdArgs {
                        repo_id: args.repo_id,
                    })
                    .await?;
                let remote = repo_remote(&self.deployment.git(), &path, args.remote.as_deref())?;
                let host = GitHostService::from_url(&remote.url).map_err(internal_error)?;
                serialize(
                    host.list_open_prs(&path, &remote.url)
                        .await
                        .map_err(internal_error)?,
                )
            }
            DomainCommand::WorkflowSourceRead => {
                let args: WorkflowSourceArgs = parse(args)?;
                serialize(read_workflow_source(&args.path)?)
            }
            DomainCommand::WorkflowSourceWrite => {
                let args: WorkflowSourceArgs = parse(args)?;
                serialize(write_workflow_source(
                    &args.path,
                    args.content.unwrap_or_default(),
                    args.expected_revision.as_deref(),
                )?)
            }
            DomainCommand::AgentListLiveTerminals => {
                let terminals = agent_terminal_registry().list_live().await;
                serialize(
                    terminals
                        .into_iter()
                        .map(|item| {
                            json!({
                                "terminalId": item.terminal_id.to_string(),
                                "agentSessionId": item.agent_session_id.to_string(),
                                "command": item.command,
                                "args": item.args,
                                "cwd": item.cwd.and_then(|path| path.to_str().map(str::to_string)),
                            })
                        })
                        .collect::<Vec<_>>(),
                )
            }
            DomainCommand::AgentPlanUsage => read_agent_plan_usage(args).await,
            DomainCommand::FrontendPreferencesGet => {
                let prefs: serde_json::Map<String, Value> =
                    read_section(&utils::assets::settings_path(), "frontend")
                        .await
                        .map_err(internal_error)?
                        .unwrap_or_default();
                serialize(prefs)
            }
            DomainCommand::FrontendPreferencesUpdate => {
                let args: PreferencesArgs = parse(args)?;
                let stored = merge_object_section(
                    &utils::assets::settings_path(),
                    "frontend",
                    args.preferences.into_iter().collect(),
                )
                .await
                .map_err(internal_error)?;
                serialize(stored)
            }
            DomainCommand::ProjectWorktreeSettingsGet => {
                let args: ProjectSettingsArgs = parse(args)?;
                serialize(
                    load_project_settings(&utils::assets::settings_path(), args.project_id)
                        .await
                        .map_err(internal_error)?,
                )
            }
            DomainCommand::ProjectWorktreeSettingsUpdate => {
                let args: ProjectSettingsArgs = parse(args)?;
                let settings = args
                    .settings
                    .ok_or_else(|| ApplicationError::bad_request("settings required"))?;
                let settings = serde_json::from_value(settings)
                    .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
                serialize(
                    save_project_settings(
                        &utils::assets::settings_path(),
                        args.project_id,
                        settings,
                    )
                    .await
                    .map_err(internal_error)?,
                )
            }
            DomainCommand::ReadBinaryAsset => {
                let args: PathArgs = parse(args)?;
                let path = self.sandbox_existing_file(&args.path).await?;
                let bytes = tokio::fs::read(&path).await.map_err(internal_error)?;
                let encoded = BASE64.encode(bytes);
                Ok(json!({
                    "data_base64": encoded,
                    "base64": encoded,
                    "mime_type": mime_type_for_path(&path),
                }))
            }
            DomainCommand::AutomationUpdateWorkflow => self.automation_update(args).await,
            DomainCommand::WorkspaceContinueConflicts => {
                self.workspace_git_write(args, |git, path, _, _, _| git.continue_conflicts(path))
                    .await
            }
            DomainCommand::WorkspaceConflictFile => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct ConflictFileArgs {
                    workspace_id: Uuid,
                    repo_id: Uuid,
                    file_path: String,
                }
                let args: ConflictFileArgs = parse(args)?;
                let path = self
                    .primary_worktree(args.workspace_id, Some(args.repo_id))
                    .await?;
                serialize(
                    self.deployment
                        .git()
                        .get_conflict_file_detail(&path, &args.file_path)
                        .map_err(internal_error)?,
                )
            }
            DomainCommand::WorkspaceWriteConflictResolution => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct WriteConflictArgs {
                    workspace_id: Uuid,
                    repo_id: Uuid,
                    file_path: String,
                    content: String,
                }
                let args: WriteConflictArgs = parse(args)?;
                let path = self
                    .primary_worktree(args.workspace_id, Some(args.repo_id))
                    .await?;
                serialize(
                    self.deployment
                        .git()
                        .write_conflict_resolution(&path, &args.file_path, &args.content)
                        .map_err(internal_error)?,
                )
            }
            DomainCommand::WorkspaceShowStash => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase")]
                struct ShowStashArgs {
                    workspace_id: Uuid,
                    repo_id: Option<Uuid>,
                    index: Option<usize>,
                }
                let args: ShowStashArgs = parse(args)?;
                let path = self
                    .primary_worktree(args.workspace_id, args.repo_id)
                    .await?;
                serialize(
                    self.deployment
                        .git()
                        .stash_show(&path, args.index.unwrap_or(0))
                        .map_err(internal_error)?,
                )
            }
            DomainCommand::WorkspaceRunSetupScript
            | DomainCommand::WorkspaceRunCleanupScript
            | DomainCommand::WorkspaceRunArchiveScript => {
                self.run_workspace_script(command, args).await
            }
            DomainCommand::WorkspaceCreatePr => self.create_workspace_pr_host(args).await,
            DomainCommand::WorkspaceAttachPr => self.attach_workspace_pr_host(args).await,
            DomainCommand::WorkspaceCreateFromPr => self.create_workspace_from_pr_host(args).await,
            other => Err(ApplicationError::internal(format!(
                "product command {} has no host implementation",
                other.as_str()
            ))),
        }
    }

    pub(crate) async fn create_workspace(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: CreateWorkspaceArgs = parse(args)?;
        if args.repos.is_empty() {
            return Err(ApplicationError::bad_request(
                "At least one repository is required",
            ));
        }
        let task = Task::find_by_id(&self.pool, args.task_id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| ApplicationError::not_found("task not found"))?;
        let agent_working_dir = if args.repos.len() == 1 {
            let repo = Repo::find_by_id(&self.pool, args.repos[0].repo_id)
                .await
                .map_err(internal_error)?
                .ok_or_else(|| ApplicationError::not_found("repository not found"))?;
            Some(match repo.default_working_dir {
                Some(subdir) => PathBuf::from(&repo.name)
                    .join(subdir)
                    .to_string_lossy()
                    .into_owned(),
                None => repo.name,
            })
        } else {
            None
        };
        let attempt_id = Uuid::new_v4();
        let branch = self
            .deployment
            .container()
            .git_branch_from_workspace(&attempt_id, &task.title)
            .await;
        let workspace = Workspace::create(
            &self.pool,
            &CreateWorkspace {
                project_id: task.project_id,
                parent_workspace_id: task.parent_workspace_id,
                branch,
                container_ref: None,
                use_worktree: true,
                agent_working_dir,
            },
            attempt_id,
            args.task_id,
        )
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
        let workspace_repos = args
            .repos
            .iter()
            .map(|repo| CreateWorkspaceRepo {
                repo_id: repo.repo_id,
                target_branch: repo.target_branch.clone(),
            })
            .collect::<Vec<_>>();
        WorkspaceRepo::create_many(&self.pool, workspace.id, &workspace_repos)
            .await
            .map_err(internal_error)?;
        let session = Session::create(
            &self.pool,
            &CreateSession {
                executor: args
                    .executor_profile_id
                    .as_ref()
                    .map(|profile| profile.executor.clone()),
                agent_id: None,
                task_id: Some(task.id),
                name: Some(task.title.clone()),
                initial_prompt: task.description.clone(),
                status: Some(SessionStatus::Todo),
            },
            Uuid::new_v4(),
            workspace.id,
        )
        .await
        .map_err(internal_error)?;
        let container_ref = self
            .deployment
            .container()
            .ensure_container_exists(&workspace)
            .await
            .map_err(internal_error)?;
        if let Some(profile) = args.executor_profile_id
            && let Ok(agent_id) = AgentId::parse(&profile.executor)
            && let Ok(launch) = self
                .conversations
                .host
                .launch_settings(&self.pool, &agent_id)
                .await
        {
            let repos = WorkspaceRepo::find_repos_for_workspace(&self.pool, workspace.id)
                .await
                .map_err(internal_error)?;
            let working_dir = conversations::resolve_absolute_workspace_agent_working_dir(
                &workspace,
                &container_ref,
                &repos,
            );
            let additional = self.conversations.host.resolve_additional_directories(
                &workspace,
                &container_ref,
                &repos,
                &working_dir,
            );
            if let Ok(agent_session) = self
                .conversations
                .agent_runtime
                .ensure_session(EnsureAgentSessionInput {
                    agent_id: agent_id.clone(),
                    launch_lock: launch.launch_lock,
                    workspace_id: workspace.id,
                    working_dir: PathBuf::from(&working_dir),
                    additional_directories: additional,
                    session_id: AgentSessionId(session.id),
                    acp_session_id: session.id.to_string(),
                    auto_approve_mode: launch.auto_approve_mode,
                    env: launch.env,
                    preferences: Default::default(),
                })
                .await
            {
                let text = session
                    .initial_prompt
                    .clone()
                    .filter(|prompt| !prompt.trim().is_empty())
                    .unwrap_or_else(|| task.title.clone());
                let _ = self
                    .conversations
                    .agent_runtime
                    .send_prompt(SendAgentPromptInput {
                        connection_id: agent_session.connection_id,
                        session_id: agent_session.id,
                        blocks: vec![AgentContentBlock::Text { text }],
                        mode_override: None,
                        config_overrides: Vec::new(),
                    })
                    .await;
            }
        }
        serialize(self.require_workspace(workspace.id).await?)
    }

    async fn update_workspace(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: UpdateWorkspaceArgs = parse(args)?;
        let workspace = self.require_workspace(args.workspace_id).await?;
        let archiving = args.archived == Some(true) && !workspace.archived;
        Workspace::update(
            &self.pool,
            args.workspace_id,
            args.archived,
            args.pinned,
            args.name.as_deref(),
        )
        .await
        .map_err(internal_error)?;
        if archiving {
            let _ = self
                .deployment
                .container()
                .archive_workspace(args.workspace_id)
                .await;
        }
        serialize(self.require_workspace(args.workspace_id).await?)
    }

    async fn delete_workspace(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: DeleteWorkspaceArgs = parse(args)?;
        let workspace = self.require_workspace(args.workspace_id).await?;
        if ExecutionProcess::has_running_non_dev_server_processes_for_workspace(
            &self.pool,
            workspace.id,
        )
        .await
        .map_err(internal_error)?
        {
            return Err(ApplicationError::conflict(
                "Cannot delete workspace while processes are running. Stop all processes first.",
            ));
        }
        let dev_servers =
            ExecutionProcess::find_running_dev_servers_by_workspace(&self.pool, workspace.id)
                .await
                .map_err(internal_error)?;
        for dev_server in dev_servers {
            let _ = self
                .deployment
                .container()
                .stop_execution(&dev_server, ExecutionProcessStatus::Killed)
                .await;
        }
        let repositories = WorkspaceRepo::find_repos_for_workspace(&self.pool, workspace.id)
            .await
            .map_err(internal_error)?;
        let _ = Task::nullify_children_by_workspace_id(&self.pool, workspace.id).await;
        if args.delete_branches.unwrap_or(false) {
            let branch = workspace.branch.clone();
            let git = self.deployment.git().clone();
            let repo_paths = repositories
                .iter()
                .map(|repo| repo.path.clone())
                .collect::<Vec<_>>();
            let _ = tokio::task::spawn_blocking(move || {
                for path in repo_paths {
                    let _ = git.delete_branch(&path, &branch);
                }
            })
            .await;
        }
        let _ = self.deployment.container().delete(&workspace).await;
        Workspace::delete(&self.pool, args.workspace_id)
            .await
            .map_err(internal_error)?;
        Ok(Value::Null)
    }

    async fn attention_inbox(&self) -> Result<Value, ApplicationError> {
        let pending: Vec<(Uuid, &'static str)> = {
            let runtime_states = self.conversations.runtime_states.lock().await;
            runtime_states
                .iter()
                .filter_map(|(session_id, runtime)| {
                    if runtime.pending_permission_id.is_some() {
                        Some((*session_id, "PENDING_PERMISSION"))
                    } else if runtime.pending_question_id.is_some() {
                        Some((*session_id, "PENDING_QUESTION"))
                    } else {
                        None
                    }
                })
                .collect()
        };
        let pending_ids: Vec<Uuid> = pending.iter().map(|(id, _)| *id).collect();
        let (pending_contexts, failed, in_review) = tokio::try_join!(
            attention_model::session_contexts(&self.pool, &pending_ids),
            attention_model::failed_last_turns(&self.pool),
            attention_model::sessions_in_review(&self.pool),
        )
        .map_err(internal_error)?;
        let mut items = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let contexts: std::collections::HashMap<_, _> = pending_contexts
            .into_iter()
            .map(|row| (row.session_id, row))
            .collect();
        for (session_id, kind) in pending {
            if let Some(row) = contexts.get(&session_id)
                && seen.insert(session_id)
            {
                items.push(attention_item(kind, row));
            }
        }
        for row in failed {
            if !seen.insert(row.session_id) {
                continue;
            }
            let kind = if row.turn_status.as_deref() == Some("interrupted") {
                "TURN_INTERRUPTED"
            } else {
                "TURN_FAILED"
            };
            items.push(attention_item(kind, &row));
        }
        for row in in_review {
            if seen.insert(row.session_id) {
                items.push(attention_item("IN_REVIEW", &row));
            }
        }
        let blocking_count = items
            .iter()
            .filter(|item| {
                matches!(
                    item.get("kind").and_then(Value::as_str),
                    Some("PENDING_PERMISSION" | "PENDING_QUESTION")
                )
            })
            .count();
        Ok(json!({
            "items": items,
            "blockingCount": blocking_count,
        }))
    }

    async fn workspace_git_read(
        &self,
        command: DomainCommand,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        let path = self.primary_worktree_from_value(&args).await?;
        let workspace_id = workspace_id_from_value(&args)?;
        let workspace = self.require_workspace(workspace_id).await?;
        let repo = self.primary_repo(workspace_id).await?;
        match command {
            DomainCommand::WorkspaceBranchStatus => self.workspace_branch_status_all(args).await,
            DomainCommand::WorkspaceCommitHistory => {
                let target = self.workspace_repo_target(&workspace, &repo).await?;
                self.git_read(repo.path.clone(), move |git, path| {
                    git.get_branch_commit_messages(path, &workspace.branch, &target)
                })
                .await
            }
            DomainCommand::WorkspaceCommitGraph => {
                let target = self.workspace_repo_target(&workspace, &repo).await?;
                let max_commits = args
                    .get("maxCommits")
                    .or_else(|| args.get("max_commits"))
                    .and_then(Value::as_u64)
                    .unwrap_or(100) as usize;
                self.git_read(path, move |git, path| {
                    git.get_commit_graph(path, &workspace.branch, &target, max_commits)
                })
                .await
            }
            DomainCommand::WorkspaceCommitDiffs => {
                let sha = args
                    .get("sha")
                    .and_then(Value::as_str)
                    .ok_or_else(|| ApplicationError::bad_request("sha is required"))?
                    .to_string();
                self.git_read(path, move |git, path| {
                    git.get_diffs(
                        git::DiffTarget::Commit {
                            repo_path: path,
                            commit_sha: &sha,
                        },
                        None,
                    )
                })
                .await
            }
            _ => Ok(Value::Null),
        }
    }

    async fn workspace_git_write(
        &self,
        args: Value,
        op: impl FnOnce(
            &git::GitService,
            &std::path::Path,
            &Workspace,
            &Repo,
            &str,
        ) -> Result<(), git::GitServiceError>
        + Send,
    ) -> Result<Value, ApplicationError> {
        let workspace_id = workspace_id_from_value(&args)?;
        let repo_id = args
            .get("repoId")
            .or_else(|| args.get("repo_id"))
            .and_then(Value::as_str)
            .and_then(|value| Uuid::parse_str(value).ok());
        let workspace = self.require_workspace(workspace_id).await?;
        let repo = match repo_id {
            Some(repo_id) => Repo::find_by_id(&self.pool, repo_id)
                .await
                .map_err(internal_error)?
                .ok_or_else(|| ApplicationError::not_found("repository not found"))?,
            None => self.primary_repo(workspace_id).await?,
        };
        let target = self.workspace_repo_target(&workspace, &repo).await?;
        let path = self
            .worktree_path(WorkspaceRepoArgs {
                workspace_id,
                repo_id: repo.id,
            })
            .await?;
        let git = self.deployment.git().clone();
        tokio::task::block_in_place(|| op(&git, &path, &workspace, &repo, &target))
            .map_err(internal_error)?;
        Ok(Value::Null)
    }

    async fn rebase_workspace(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: RebaseWorkspaceArgs = parse(args)?;
        let workspace = self.require_workspace(args.workspace_id).await?;
        let repo = match args.repo_id {
            Some(repo_id) => Repo::find_by_id(&self.pool, repo_id)
                .await
                .map_err(internal_error)?
                .ok_or_else(|| ApplicationError::not_found("repository not found"))?,
            None => self.primary_repo(args.workspace_id).await?,
        };
        let fallback = self.workspace_repo_target(&workspace, &repo).await?;
        let old_base = args
            .old_base_branch
            .clone()
            .unwrap_or_else(|| fallback.clone());
        let new_base = args
            .new_base_branch
            .clone()
            .unwrap_or_else(|| fallback.clone());
        if !self
            .deployment
            .git()
            .check_branch_exists(&repo.path, &new_base)
            .map_err(internal_error)?
        {
            return Err(ApplicationError::bad_request(format!(
                "Branch '{new_base}' does not exist in the repository"
            )));
        }
        WorkspaceRepo::update_target_branch(&self.pool, workspace.id, repo.id, &new_base)
            .await
            .map_err(internal_error)?;
        let path = self
            .worktree_path(WorkspaceRepoArgs {
                workspace_id: args.workspace_id,
                repo_id: repo.id,
            })
            .await?;
        let git = self.deployment.git().clone();
        let branch = workspace.branch.clone();
        let repo_path = repo.path.clone();
        let new_base_for_error = new_base.clone();
        match tokio::task::spawn_blocking(move || {
            git.rebase_branch(&repo_path, &path, &new_base, &old_base, &branch)
        })
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?
        {
            Ok(_) => serialize(json!({ "error": null })),
            Err(git::GitServiceError::MergeConflicts {
                message,
                conflicted_files,
            }) => serialize(json!({
                "error": {
                    "type": "merge_conflicts",
                    "message": message,
                    "op": "rebase",
                    "conflictedFiles": conflicted_files,
                    "targetBranch": new_base_for_error,
                }
            })),
            Err(git::GitServiceError::RebaseInProgress) => serialize(json!({
                "error": { "type": "rebase_in_progress" }
            })),
            Err(error) => Err(internal_error(error)),
        }
    }

    async fn workspace_repo_target(
        &self,
        workspace: &Workspace,
        repo: &Repo,
    ) -> Result<String, ApplicationError> {
        Ok(
            WorkspaceRepo::find_by_workspace_and_repo_id(&self.pool, workspace.id, repo.id)
                .await
                .map_err(internal_error)?
                .map(|row| row.target_branch)
                .filter(|branch| !branch.is_empty())
                .unwrap_or_else(|| workspace.branch.clone()),
        )
    }

    async fn repo_git_write(
        &self,
        args: Value,
        op: impl FnOnce(&git::GitService, &std::path::Path) -> Result<(), git::GitServiceError> + Send,
    ) -> Result<Value, ApplicationError> {
        let args: RepoIdArgs = parse(args)?;
        self.git_write(self.repo_path(args).await?, op).await
    }

    async fn commit_read(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: CommitArgs = parse(args)?;
        let path = if let Some(workspace_id) = args.workspace_id {
            self.primary_worktree(workspace_id, args.repo_id).await?
        } else if let Some(repo_id) = args.repo_id {
            self.repo_path(RepoIdArgs { repo_id }).await?
        } else {
            return Err(ApplicationError::bad_request("workspace or repo required"));
        };
        let sha = args
            .sha
            .or(args.commit_hash)
            .ok_or_else(|| ApplicationError::bad_request("sha required"))?;
        self.git_read(path, |git, path| git.get_commit_detail(path, &sha))
            .await
    }

    async fn stash_op(
        &self,
        args: Value,
        op: fn(&git::GitService, &std::path::Path, usize) -> Result<(), git::GitServiceError>,
    ) -> Result<Value, ApplicationError> {
        let args: StashIndexArgs = parse(args)?;
        let path = self
            .primary_worktree(args.workspace_id, args.repo_id)
            .await?;
        self.git_write(path, |git, path| op(git, path, args.index.unwrap_or(0)))
            .await
    }

    async fn primary_worktree_from_value(&self, args: &Value) -> Result<PathBuf, ApplicationError> {
        let workspace_id = workspace_id_from_value(args)?;
        let repo_id = args
            .get("repoId")
            .or_else(|| args.get("repo_id"))
            .and_then(Value::as_str)
            .and_then(|value| Uuid::parse_str(value).ok());
        self.primary_worktree(workspace_id, repo_id).await
    }

    async fn primary_worktree(
        &self,
        workspace_id: Uuid,
        repo_id: Option<Uuid>,
    ) -> Result<PathBuf, ApplicationError> {
        let repo_id = match repo_id {
            Some(repo_id) => repo_id,
            None => self.primary_repo(workspace_id).await?.id,
        };
        self.worktree_path(WorkspaceRepoArgs {
            workspace_id,
            repo_id,
        })
        .await
    }

    async fn primary_repo(&self, workspace_id: Uuid) -> Result<Repo, ApplicationError> {
        WorkspaceRepo::find_repos_for_workspace(&self.pool, workspace_id)
            .await
            .map_err(internal_error)?
            .into_iter()
            .next()
            .ok_or_else(|| ApplicationError::not_found("workspace has no repository"))
    }
}

fn workspace_id_from_value(args: &Value) -> Result<Uuid, ApplicationError> {
    args.get("workspaceId")
        .or_else(|| args.get("workspace_id"))
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value).ok())
        .ok_or_else(|| ApplicationError::bad_request("workspaceId required"))
}

fn current_branch(path: &std::path::Path) -> Result<String, git::GitServiceError> {
    git::GitCli::new()
        .git(path, ["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|value| value.trim().to_owned())
        .map_err(git::GitServiceError::from)
}

fn repo_remote(
    git: &git::GitService,
    path: &std::path::Path,
    name: Option<&str>,
) -> Result<git::GitRemote, ApplicationError> {
    match name {
        Some(name) => Ok(git::GitRemote {
            name: name.to_owned(),
            url: git.get_remote_url(path, name).map_err(internal_error)?,
        }),
        None => git.get_default_remote(path).map_err(internal_error),
    }
}

async fn read_agent_plan_usage(args: Value) -> Result<Value, ApplicationError> {
    let args: AgentIdArgs = parse_payload_or_value(args)?;
    let agent_id = AgentId::parse(&args.agent_id)
        .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
    serialize(AgentPlanUsageApplicationService::read(&agent_id).await)
}

fn parse_payload_or_value<T: serde::de::DeserializeOwned>(
    args: Value,
) -> Result<T, ApplicationError> {
    if let Some(payload) = args.get("payload") {
        return parse(payload.clone());
    }
    parse(args)
}

const WORKFLOW_SOURCE_MAX_BYTES: usize = 4 * 1024 * 1024;

fn workflow_source_revision(content: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("sha256:{:x}", Sha256::digest(content))
}

fn resolve_workflow_source_path(path: &str) -> Result<PathBuf, ApplicationError> {
    let expanded = if path.starts_with("~/") {
        let home = dirs::home_dir().ok_or_else(|| {
            ApplicationError::internal("Unable to resolve the user home directory")
        })?;
        let expanded = home.join(path.trim_start_matches("~/"));
        if path.starts_with("~/.vibex/workflows/") {
            if let Some(parent) = expanded.parent() {
                std::fs::create_dir_all(parent).map_err(internal_error)?;
            }
        }
        expanded
    } else {
        crate::host_ops::sanitize_absolute(path)?
    };
    if !expanded
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".vibex-workflow.json"))
    {
        return Err(ApplicationError::bad_request(
            "Workflow source must end with .vibex-workflow.json",
        ));
    }
    Ok(expanded)
}

fn read_workflow_source(path: &str) -> Result<Value, ApplicationError> {
    let path = resolve_workflow_source_path(path)?;
    let bytes = std::fs::read(&path)
        .map_err(|_| ApplicationError::not_found(format!("{}: not found", path.display())))?;
    if bytes.len() > WORKFLOW_SOURCE_MAX_BYTES {
        return Err(ApplicationError::bad_request(
            "Workflow source exceeds 4 MiB",
        ));
    }
    let content = String::from_utf8(bytes.clone())
        .map_err(|_| ApplicationError::bad_request("Workflow source must be UTF-8 JSON"))?;
    Ok(json!({
        "path": path.to_string_lossy(),
        "content": content,
        "revision": workflow_source_revision(&bytes),
    }))
}

fn write_workflow_source(
    path: &str,
    content: String,
    expected_revision: Option<&str>,
) -> Result<Value, ApplicationError> {
    if content.len() > WORKFLOW_SOURCE_MAX_BYTES {
        return Err(ApplicationError::bad_request(
            "Workflow source exceeds 4 MiB",
        ));
    }
    serde_json::from_str::<workflows::WorkflowDefinition>(&content)
        .map_err(|error| ApplicationError::bad_request(format!("Invalid Workflow JSON: {error}")))
        .and_then(|definition| {
            workflows::validate_definition(&definition)
                .map_err(|error| ApplicationError::bad_request(error.to_string()))
        })?;
    let path = resolve_workflow_source_path(path)?;
    let parent = path
        .parent()
        .ok_or_else(|| ApplicationError::bad_request("Workflow source has no parent directory"))?;
    if !parent.is_dir() {
        return Err(ApplicationError::not_found(format!(
            "Parent directory does not exist: {}",
            parent.display()
        )));
    }
    match (std::fs::read(&path), expected_revision) {
        (Ok(current), Some(expected)) if workflow_source_revision(&current) != expected => {
            return Err(ApplicationError::conflict(
                "Workflow source changed outside this editor; reload before saving",
            ));
        }
        (Ok(_), None) => {
            return Err(ApplicationError::conflict(
                "Existing Workflow source requires expectedRevision",
            ));
        }
        (Err(error), Some(_)) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(ApplicationError::conflict(
                "Workflow source was deleted outside this editor",
            ));
        }
        (Err(error), None) if error.kind() == std::io::ErrorKind::NotFound => {}
        (Err(error), _) => return Err(internal_error(error)),
        _ => {}
    }
    let temporary = parent.join(format!(
        ".{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("workflow")
    ));
    std::fs::write(&temporary, content.as_bytes()).map_err(internal_error)?;
    std::fs::rename(&temporary, &path).map_err(internal_error)?;
    Ok(json!({
        "revision": workflow_source_revision(content.as_bytes()),
    }))
}

fn mime_type_for_path(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .unwrap_or_default();
    match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "tif" | "tiff" => "image/tiff",
        "ico" => "image/x-icon",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

fn attention_item(kind: &str, row: &attention_model::AttentionSessionRow) -> Value {
    json!({
        "kind": kind,
        "sessionId": row.session_id,
        "workspaceId": row.workspace_id,
        "taskId": row.task_id,
        "projectId": row.project_id,
        "projectName": row.project_name,
        "sessionName": row.session_name,
        "agentType": row.agent_type,
        "detail": row.detail,
        "happenedAtMs": row.happened_at.map(|at| at.timestamp_millis()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unsupported_agent_returns_typed_unavailable_not_null() {
        let value = read_agent_plan_usage(json!({ "agentId": "gemini" }))
            .await
            .expect("plan usage");
        assert_eq!(
            value,
            json!({
                "type": "UNAVAILABLE",
                "reason": "UNSUPPORTED_AGENT"
            })
        );
    }

    #[tokio::test]
    async fn payload_wrapped_agent_id_is_accepted() {
        let value = read_agent_plan_usage(json!({ "payload": { "agentId": "gemini" } }))
            .await
            .expect("plan usage");
        assert_eq!(value["type"], "UNAVAILABLE");
        assert_ne!(value, Value::Null);
    }
}
