use std::path::PathBuf;

use agents::{
    AgentContentBlock, AgentId, AgentSessionId, EnsureAgentSessionInput, SendAgentPromptInput,
    terminal::agent_terminal_registry,
};
use application::{ApplicationError, DomainCommand};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use db::models::{
    attention as attention_model,
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
struct IdArgs {
    id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceRepoSpec {
    repo_id: Uuid,
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
    task_id: Uuid,
    repos: Vec<WorkspaceRepoSpec>,
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
    new_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TargetBranchArgs {
    workspace_id: Uuid,
    repo_id: Option<Uuid>,
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
    tag_name: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateTagArgs {
    id: Uuid,
    tag_name: Option<String>,
    content: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateTaskArgs {
    id: Uuid,
    title: Option<String>,
    description: Option<String>,
    status: Option<TaskStatus>,
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
    contents: Option<String>,
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
                self.workspace_git_write(args, |git, path, workspace, repo| {
                    git.push_to_remote(path, &workspace.branch, false)?;
                    let _ = repo;
                    Ok(())
                })
                .await
            }
            DomainCommand::WorkspacePull => {
                self.workspace_git_write(args, |git, path, _, _| git.pull(path).map(|_| ()))
                    .await
            }
            DomainCommand::WorkspaceFetch => {
                self.workspace_git_write(args, |git, path, _, _| git.fetch_all(path))
                    .await
            }
            DomainCommand::WorkspaceMerge => {
                self.workspace_git_write(args, |git, path, workspace, repo| {
                    git.merge_changes(
                        &repo.path,
                        path,
                        &workspace.branch,
                        &workspace_target_branch(workspace, repo),
                        &format!("Merge {}", workspace.branch),
                    )
                    .map(|_| ())
                })
                .await
            }
            DomainCommand::WorkspaceRebase => {
                self.workspace_git_write(args, |git, path, workspace, repo| {
                    let target = workspace_target_branch(workspace, repo);
                    git.rebase_branch(&repo.path, path, &target, &target, &workspace.branch)
                        .map(|_| ())
                })
                .await
            }
            DomainCommand::WorkspaceRebaseBack => {
                self.workspace_git_write(args, |git, path, workspace, repo| {
                    git.rebase_back(
                        &repo.path,
                        path,
                        &workspace.branch,
                        &workspace_target_branch(workspace, repo),
                        "",
                    )
                    .map(|_| ())
                })
                .await
            }
            DomainCommand::WorkspaceContinueRebase => {
                self.workspace_git_write(args, |git, path, _, _| git.continue_rebase(path))
                    .await
            }
            DomainCommand::WorkspaceAbortConflicts => {
                self.workspace_git_write(args, |git, path, _, _| {
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
                self.workspace_git_write(args, |git, path, _, _| {
                    git.stash_push(path, None, true).map(|_| ())
                })
                .await
            }
            DomainCommand::WorkspaceStashList => {
                let path = self.primary_worktree_from_value(&args).await?;
                self.git_read(path, git::GitService::stash_list).await
            }
            DomainCommand::WorkspaceStashApply => self.stash_op(args, git::GitService::stash_apply).await,
            DomainCommand::WorkspaceStashPop => self.stash_op(args, git::GitService::stash_pop).await,
            DomainCommand::WorkspaceStashDrop => self.stash_op(args, git::GitService::stash_drop).await,
            DomainCommand::WorkspaceRenameBranch => {
                let args: RenameBranchArgs = parse(args)?;
                let path = self
                    .primary_worktree(args.workspace_id, args.repo_id)
                    .await?;
                self.git_write(path, |git, path| git.create_branch(path, &args.new_name, None))
                    .await?;
                Workspace::update_branch_name(&self.pool, args.workspace_id, &args.new_name)
                    .await
                    .map_err(internal_error)?;
                serialize(self.require_workspace(args.workspace_id).await?)
            }
            DomainCommand::WorkspaceChangeTargetBranch => {
                let args: TargetBranchArgs = parse(args)?;
                let repo_id = match args.repo_id {
                    Some(repo_id) => repo_id,
                    None => self.primary_repo(args.workspace_id).await?.id,
                };
                sqlx::query(
                    "UPDATE workspace_repos SET target_branch = ? WHERE workspace_id = ? AND repo_id = ?",
                )
                .bind(&args.target_branch)
                .bind(args.workspace_id)
                .bind(repo_id)
                .execute(&self.pool)
                .await
                .map_err(internal_error)?;
                serialize(self.require_workspace(args.workspace_id).await?)
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
                serialize(Tag::find_all(&self.pool).await.map_err(internal_error)?)
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
            DomainCommand::TaskCreate | DomainCommand::TaskCreateAndStart => {
                let payload: CreateTask = parse_payload_or_value(args)?;
                let task = Task::create(&self.pool, &payload, Uuid::new_v4())
                    .await
                    .map_err(internal_error)?;
                serialize(task)
            }
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
                let path = self.repo_path(RepoIdArgs { repo_id: args.repo_id }).await?;
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
                let path = self.repo_path(RepoIdArgs { repo_id: args.repo_id }).await?;
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
                let path = self.repo_path(RepoIdArgs { repo_id: args.repo_id }).await?;
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
                let path = self.repo_path(RepoIdArgs { repo_id: args.repo_id }).await?;
                serialize(
                    self.deployment
                        .file_search()
                        .search_repo(
                            &path,
                            &args.q,
                            services::services::file_search::SearchMode::TaskForm,
                        )
                        .await
                        .map_err(ApplicationError::internal)?,
                )
            }
            DomainCommand::RepoIssues => {
                let args: RepoIssuesArgs = parse(args)?;
                let path = self.repo_path(RepoIdArgs { repo_id: args.repo_id }).await?;
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
                let path = self.repo_path(RepoIdArgs { repo_id: args.repo_id }).await?;
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
                let path = self.sandbox_existing_file(&args.path).await?;
                serialize(tokio::fs::read_to_string(path).await.map_err(internal_error)?)
            }
            DomainCommand::WorkflowSourceWrite => {
                let args: WorkflowSourceArgs = parse(args)?;
                let path = self.sandbox_existing_file(&args.path).await.or_else(|_| {
                    crate::host_ops::sanitize_absolute(&args.path)
                })?;
                tokio::fs::write(path, args.contents.unwrap_or_default())
                    .await
                    .map_err(internal_error)?;
                Ok(Value::Null)
            }
            DomainCommand::AgentRefreshCapabilityCatalog
            | DomainCommand::AgentCapabilityCatalogFresh => {
                let args: AgentIdArgs = parse(args).unwrap_or(AgentIdArgs {
                    agent_id: String::new(),
                });
                self.agent_capability_catalog(json!({ "agentId": args.agent_id }))
                    .await
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
            DomainCommand::AgentPlanUsage => Ok(Value::Null),
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
                let bytes = tokio::fs::read(path).await.map_err(internal_error)?;
                Ok(json!({ "base64": BASE64.encode(bytes) }))
            }
            DomainCommand::AutomationExportSpec => serialize(json!({})),
            DomainCommand::AutomationImportSpec => self.automation_create(args).await,
            DomainCommand::AutomationUpdateWorkflow => self.automation_update(args).await,
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
        let args: WorkspaceIdArgs = parse(args)?;
        let workspace = self.require_workspace(args.workspace_id).await?;
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
            DomainCommand::WorkspaceBranchStatus => self
                .git_read(path, |git, path| {
                    git.get_branch_status(path, &workspace.branch, &workspace_target_branch(&workspace, &repo))
                })
                .await,
            DomainCommand::WorkspaceCommitHistory => self
                .git_read(repo.path.clone(), |git, path| {
                    git.get_branch_commit_messages(
                        path,
                        &workspace.branch,
                        &workspace_target_branch(&workspace, &repo),
                    )
                })
                .await,
            DomainCommand::WorkspaceCommitGraph => {
                let target = workspace_target_branch(&workspace, &repo);
                self.git_read(path, |git, path| {
                    git.get_commit_graph(path, &workspace.branch, &target, 100)
                })
                .await
            }
            DomainCommand::WorkspaceCommitDiffs => {
                self.git_read(path, git::GitService::get_file_diffs).await
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
        let path = self
            .worktree_path(WorkspaceRepoArgs {
                workspace_id,
                repo_id: repo.id,
            })
            .await?;
        let git = self.deployment.git().clone();
        tokio::task::block_in_place(|| op(&git, &path, &workspace, &repo)).map_err(internal_error)?;
        Ok(Value::Null)
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

fn workspace_target_branch(workspace: &Workspace, repo: &Repo) -> String {
    let _ = repo;
    workspace.branch.clone()
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

fn parse_payload_or_value<T: serde::de::DeserializeOwned>(
    args: Value,
) -> Result<T, ApplicationError> {
    if let Some(payload) = args.get("payload") {
        return parse(payload.clone());
    }
    parse(args)
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
