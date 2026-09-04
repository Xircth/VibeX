use std::{
    collections::HashSet,
    path::{Component, Path, PathBuf},
};

use application::{ApplicationError, DomainCommand};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use db::models::{
    conversation::DbConversationSummary,
    project::{CreateProject, Project, UpdateProject},
    project_repo::{CreateProjectRepo, ProjectRepo},
    repo::Repo,
    session::{CreateSession, Session, SessionStatus},
    task::Task,
    workspace::Workspace,
    workspace_repo::WorkspaceRepo,
};
use deployment::Deployment;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::domains::{ServerApplicationDomains, internal_error, parse, serialize};

const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".cache",
    "__pycache__",
];

impl ServerApplicationDomains {
    pub(crate) async fn host_ops(
        &self,
        command: DomainCommand,
        args: Value,
    ) -> Result<Value, ApplicationError> {
        match command {
            DomainCommand::ProjectGet => self.get_project(args).await,
            DomainCommand::ProjectCreate => self.create_project(args).await,
            DomainCommand::ProjectUpdate => self.update_project(args).await,
            DomainCommand::ProjectDelete => self.delete_project(args).await,
            DomainCommand::ProjectSearchFiles => self.search_project_files(args).await,
            DomainCommand::ProjectAddRepository => self.add_project_repository(args).await,
            DomainCommand::ProjectDeleteRepository => self.delete_project_repository(args).await,
            DomainCommand::RepoList => {
                serialize(Repo::list_all(&self.pool).await.map_err(internal_error)?)
            }
            DomainCommand::RepoGet => {
                let args: RepoIdArgs = parse(args)?;
                serialize(
                    self.deployment
                        .repo()
                        .get_by_id(&self.pool, args.repo_id)
                        .await
                        .map_err(internal_error)?,
                )
            }
            DomainCommand::RepoRegister => self.register_repo(args).await,
            DomainCommand::RepoRecent => serialize(
                Repo::list_by_recent_workspace_usage(&self.pool)
                    .await
                    .map_err(internal_error)?,
            ),
            DomainCommand::RepoInit => self.init_repo(args).await,
            DomainCommand::RepoCheckPath => {
                let args: PathArgs = parse(args)?;
                serialize(
                    self.deployment
                        .repo()
                        .is_git_repo_path(&args.path)
                        .map_err(|error| ApplicationError::bad_request(error.to_string()))?,
                )
            }
            DomainCommand::RepoClone => self.clone_repo(args).await,
            DomainCommand::RepoGitStatus => {
                self.git_read(
                    self.repo_path(parse(args)?).await?,
                    git::GitService::get_detailed_status,
                )
                .await
            }
            DomainCommand::RepoFileDiffs => {
                self.git_read(
                    self.repo_path(parse(args)?).await?,
                    git::GitService::get_file_diffs,
                )
                .await
            }
            DomainCommand::RepoStageFile => {
                let args: RepoFileArgs = parse(args)?;
                self.git_write(
                    self.repo_path(RepoIdArgs {
                        repo_id: args.repo_id,
                    })
                    .await?,
                    |git, path| git.stage_file(path, &args.file_path),
                )
                .await
            }
            DomainCommand::RepoUnstageFile => {
                let args: RepoFileArgs = parse(args)?;
                self.git_write(
                    self.repo_path(RepoIdArgs {
                        repo_id: args.repo_id,
                    })
                    .await?,
                    |git, path| git.unstage_file(path, &args.file_path),
                )
                .await
            }
            DomainCommand::RepoRevertFile => {
                let args: RepoFileArgs = parse(args)?;
                self.git_write(
                    self.repo_path(RepoIdArgs {
                        repo_id: args.repo_id,
                    })
                    .await?,
                    |git, path| git.revert_file(path, &args.file_path),
                )
                .await
            }
            DomainCommand::RepoStageAll => {
                self.git_write(
                    self.repo_path(parse(args)?).await?,
                    git::GitService::stage_all,
                )
                .await
            }
            DomainCommand::RepoRevertAll => {
                self.git_write(
                    self.repo_path(parse(args)?).await?,
                    git::GitService::revert_all,
                )
                .await
            }
            DomainCommand::RepoCommit => {
                let args: RepoCommitArgs = parse(args)?;
                self.git_write(
                    self.repo_path(RepoIdArgs {
                        repo_id: args.repo_id,
                    })
                    .await?,
                    |git, path| git.commit_changes(path, &args.message),
                )
                .await
            }
            DomainCommand::RepoGitLog => {
                self.git_read(
                    self.repo_path(parse(args)?).await?,
                    git::GitService::get_log_status,
                )
                .await
            }
            DomainCommand::RepoCheckoutBranch => {
                let args: RepoBranchArgs = parse(args)?;
                self.git_write(
                    self.repo_path(RepoIdArgs {
                        repo_id: args.repo_id,
                    })
                    .await?,
                    |git, path| git.checkout_branch(path, &args.branch),
                )
                .await
            }
            DomainCommand::RepoCreateBranch => {
                let args: RepoBranchArgs = parse(args)?;
                self.git_write(
                    self.repo_path(RepoIdArgs {
                        repo_id: args.repo_id,
                    })
                    .await?,
                    |git, path| git.create_branch(path, &args.branch, None),
                )
                .await
            }
            DomainCommand::RepoDeleteBranch => {
                let args: RepoBranchArgs = parse(args)?;
                let path = self
                    .repo_path(RepoIdArgs {
                        repo_id: args.repo_id,
                    })
                    .await?;
                git::GitCli::new()
                    .git(&path, ["branch", "-D", &args.branch])
                    .map_err(internal_error)?;
                Ok(Value::Null)
            }
            DomainCommand::WorkspaceList => {
                let args: OptionalTaskArgs = parse(args).unwrap_or_default();
                serialize(
                    Workspace::fetch_all(&self.pool, args.task_id)
                        .await
                        .map_err(internal_error)?,
                )
            }
            DomainCommand::WorkspaceListByProject => {
                let args: ProjectIdArgs = parse(args)?;
                serialize(
                    Workspace::fetch_by_project_id(&self.pool, args.project_id)
                        .await
                        .map_err(internal_error)?,
                )
            }
            DomainCommand::WorkspaceGet => {
                let args: WorkspaceIdArgs = parse(args)?;
                serialize(self.require_workspace(args.workspace_id).await?)
            }
            DomainCommand::WorkspaceCount => serialize(
                Workspace::count_all(&self.pool)
                    .await
                    .map_err(internal_error)?,
            ),
            DomainCommand::WorkspaceRepos => self.workspace_repos(args).await,
            DomainCommand::WorkspaceGitStatus => {
                self.git_read(
                    self.worktree_path(parse(args)?).await?,
                    git::GitService::get_detailed_status,
                )
                .await
            }
            DomainCommand::WorkspaceStageFile => {
                let args: WorkspaceFileArgs = parse(args)?;
                self.git_write(
                    self.worktree_path(WorkspaceRepoArgs {
                        workspace_id: args.workspace_id,
                        repo_id: args.repo_id,
                    })
                    .await?,
                    |git, path| git.stage_file(path, &args.file_path),
                )
                .await
            }
            DomainCommand::WorkspaceStageAll => {
                self.git_write(
                    self.worktree_path(parse(args)?).await?,
                    git::GitService::stage_all,
                )
                .await
            }
            DomainCommand::WorkspaceUnstageFile => {
                let args: WorkspaceFileArgs = parse(args)?;
                self.git_write(
                    self.worktree_path(WorkspaceRepoArgs {
                        workspace_id: args.workspace_id,
                        repo_id: args.repo_id,
                    })
                    .await?,
                    |git, path| git.unstage_file(path, &args.file_path),
                )
                .await
            }
            DomainCommand::WorkspaceRevertFile => {
                let args: WorkspaceFileArgs = parse(args)?;
                self.git_write(
                    self.worktree_path(WorkspaceRepoArgs {
                        workspace_id: args.workspace_id,
                        repo_id: args.repo_id,
                    })
                    .await?,
                    |git, path| git.revert_file(path, &args.file_path),
                )
                .await
            }
            DomainCommand::WorkspaceRevertAll => {
                self.git_write(
                    self.worktree_path(parse(args)?).await?,
                    git::GitService::revert_all,
                )
                .await
            }
            DomainCommand::WorkspaceFileDiffs => {
                self.git_read(
                    self.worktree_path(parse(args)?).await?,
                    git::GitService::get_file_diffs,
                )
                .await
            }
            DomainCommand::WorkspaceCommit => {
                let args: WorkspaceCommitArgs = parse(args)?;
                self.git_write(
                    self.worktree_path(WorkspaceRepoArgs {
                        workspace_id: args.workspace_id,
                        repo_id: args.repo_id,
                    })
                    .await?,
                    |git, path| git.commit_changes(path, &args.message),
                )
                .await
            }
            DomainCommand::WorkspaceGitLog => {
                self.git_read(
                    self.worktree_path(parse(args)?).await?,
                    git::GitService::get_log_status,
                )
                .await
            }
            DomainCommand::WorkspaceCommitDetail => {
                let args: WorkspaceCommitDetailArgs = parse(args)?;
                self.git_read(
                    self.worktree_path(WorkspaceRepoArgs {
                        workspace_id: args.workspace_id,
                        repo_id: args.repo_id,
                    })
                    .await?,
                    |git, path| git.get_commit_detail(path, &args.sha),
                )
                .await
            }
            DomainCommand::WorkspaceCheckoutBranch => {
                let args: WorkspaceBranchArgs = parse(args)?;
                self.git_write(
                    self.worktree_path(WorkspaceRepoArgs {
                        workspace_id: args.workspace_id,
                        repo_id: args.repo_id,
                    })
                    .await?,
                    |git, path| git.checkout_branch(path, &args.branch),
                )
                .await
            }
            DomainCommand::WorkspaceCreateBranch => {
                let args: WorkspaceBranchArgs = parse(args)?;
                self.git_write(
                    self.worktree_path(WorkspaceRepoArgs {
                        workspace_id: args.workspace_id,
                        repo_id: args.repo_id,
                    })
                    .await?,
                    |git, path| git.create_branch(path, &args.branch, None),
                )
                .await
            }
            DomainCommand::WorkspaceDeleteBranch => {
                let args: WorkspaceBranchArgs = parse(args)?;
                let path = self
                    .worktree_path(WorkspaceRepoArgs {
                        workspace_id: args.workspace_id,
                        repo_id: args.repo_id,
                    })
                    .await?;
                git::GitCli::new()
                    .git(&path, ["branch", "-D", &args.branch])
                    .map_err(internal_error)?;
                Ok(Value::Null)
            }
            DomainCommand::SessionList => {
                let args: WorkspaceIdArgs = parse(args)?;
                serialize(
                    Session::find_by_workspace_id(&self.pool, args.workspace_id)
                        .await
                        .map_err(internal_error)?,
                )
            }
            DomainCommand::SessionSummaries => self.session_summaries(args).await,
            DomainCommand::SessionGet => {
                let args: SessionIdArgs = parse(args)?;
                serialize(self.require_session(args.session_id).await?)
            }
            DomainCommand::SessionCreate => self.create_session(args).await,
            DomainCommand::SessionCreateProjectRoot => self.create_project_root_session(args).await,
            DomainCommand::SessionCreateProject => self.create_project_session(args).await,
            DomainCommand::SessionEnsureWorkspace => self.ensure_project_workspace(args).await,
            DomainCommand::SessionRename => self.rename_session(args).await,
            DomainCommand::SessionUpdateStatus => {
                let args: SessionStatusArgs = parse(args)?;
                conversations::workbench_status::apply_manual_status(
                    &self.pool,
                    args.session_id,
                    args.status,
                )
                .await
                .map_err(internal_error)?;
                serialize(self.require_session(args.session_id).await?)
            }
            DomainCommand::SessionMarkViewed => {
                let args: SessionIdArgs = parse(args)?;
                conversations::workbench_status::mark_latest_turn_viewed(
                    &self.pool,
                    args.session_id,
                )
                .await
                .map_err(internal_error)?;
                serialize(self.require_session(args.session_id).await?)
            }
            DomainCommand::SessionSetPinned => {
                let args: SessionPinnedArgs = parse(args)?;
                DbConversationSummary::set_pinned(&self.pool, args.session_id, args.pinned)
                    .await
                    .map_err(internal_error)?;
                serialize(self.require_session(args.session_id).await?)
            }
            DomainCommand::SessionDelete => {
                let args: SessionIdArgs = parse(args)?;
                Session::delete(&self.pool, args.session_id)
                    .await
                    .map_err(internal_error)?;
                Ok(Value::Null)
            }
            DomainCommand::FileTree => self.file_tree(args).await,
            DomainCommand::FileRead => {
                let args: PathArgs = parse(args)?;
                let path = self.sandbox_existing_file(&args.path).await?;
                serialize(
                    tokio::fs::read_to_string(path)
                        .await
                        .map_err(internal_error)?,
                )
            }
            DomainCommand::FileSave => self.save_file(args).await,
            DomainCommand::FileDelete => {
                let args: PathArgs = parse(args)?;
                let path = self.sandbox_existing_path(&args.path).await?;
                if path.is_dir() {
                    tokio::fs::remove_dir_all(path)
                        .await
                        .map_err(internal_error)?;
                } else {
                    tokio::fs::remove_file(path).await.map_err(internal_error)?;
                }
                Ok(Value::Null)
            }
            DomainCommand::FileListChildren => self.list_directory_children(args).await,
            DomainCommand::FileReadTruncated => self.read_file_truncated(args).await,
            DomainCommand::FileCopy => self.copy_item(args).await,
            DomainCommand::FileMove => self.move_item(args).await,
            DomainCommand::FileCreateDirectory => {
                let args: PathArgs = parse(args)?;
                let path = sanitize_absolute(&args.path)?;
                tokio::fs::create_dir_all(path)
                    .await
                    .map_err(internal_error)?;
                Ok(Value::Null)
            }
            DomainCommand::FileSearchText => self.search_workspace_text(args).await,
            DomainCommand::FileListDirectory => {
                let args: OptionalPathArgs = parse(args).unwrap_or_default();
                serialize(
                    self.deployment
                        .filesystem()
                        .list_directory(args.path)
                        .await
                        .map_err(|error| ApplicationError::bad_request(error.to_string()))?,
                )
            }
            DomainCommand::FileListGitRepos => {
                let args: OptionalPathArgs = parse(args).unwrap_or_default();
                serialize(
                    self.deployment
                        .filesystem()
                        .list_git_repos(args.path, 2_000, 2_300, Some(4))
                        .await
                        .map_err(|error| ApplicationError::bad_request(error.to_string()))?,
                )
            }
            DomainCommand::FileAtHead => {
                let args: FileAtHeadArgs = parse(args)?;
                let path = sanitize_absolute(&args.file_path)?;
                let parent = path
                    .parent()
                    .ok_or_else(|| ApplicationError::bad_request("file has no parent"))?;
                let relative = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or_else(|| ApplicationError::bad_request("invalid file name"))?;
                let content = git::GitCli::new()
                    .git(parent, ["show", &format!("HEAD:{relative}")])
                    .map_err(internal_error)?;
                serialize(content)
            }
            DomainCommand::TerminalCreate => self.create_terminal(args).await,
            DomainCommand::TerminalWrite => self.write_terminal(args).await,
            DomainCommand::TerminalResize => self.resize_terminal(args).await,
            DomainCommand::TerminalClose => {
                let args: TerminalSessionArgs = parse(args)?;
                self.deployment
                    .pty()
                    .close_session(args.session_id)
                    .await
                    .map_err(internal_error)?;
                Ok(Value::Null)
            }
            DomainCommand::TerminalAttach => {
                let args: TerminalSessionArgs = parse(args)?;
                if !self.deployment.pty().session_exists(&args.session_id) {
                    return Err(ApplicationError::not_found(format!(
                        "terminal {}",
                        args.session_id
                    )));
                }
                serialize(args.session_id)
            }
            DomainCommand::AgentManagementDetail => {
                let args: AgentIdArgs = parse(args)?;
                let views =
                    services::services::agent_management::AgentManagementApplicationService::new(
                        self.pool.clone(),
                    )
                    .list()
                    .await
                    .map_err(internal_error)?;
                let view = views
                    .into_iter()
                    .find(|view| view.agent_id.as_str() == args.agent_id)
                    .ok_or_else(|| {
                        ApplicationError::not_found(format!("agent {}", args.agent_id))
                    })?;
                serialize(view)
            }
            DomainCommand::AgentManagementSetEnabled => {
                let args: AgentEnabledArgs = parse(args)?;
                let changed = sqlx::query(
                    "UPDATE agent_membership SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE agent_id = ?",
                )
                .bind(args.enabled)
                .bind(&args.agent_id)
                .execute(&self.pool)
                .await
                .map_err(internal_error)?
                .rows_affected();
                if changed == 0 {
                    return Err(ApplicationError::not_found(format!(
                        "agent {}",
                        args.agent_id
                    )));
                }
                Ok(Value::Null)
            }
            DomainCommand::AgentManagementRefresh => {
                let _ =
                    services::services::agent_management::AgentManagementApplicationService::new(
                        self.pool.clone(),
                    )
                    .refresh_component_integrity()
                    .await;
                serialize(
                    services::services::agent_management::AgentManagementApplicationService::new(
                        self.pool.clone(),
                    )
                    .list()
                    .await
                    .map_err(internal_error)?,
                )
            }
            other => Err(ApplicationError::not_found(format!(
                "command `{}` is not registered",
                other.as_str()
            ))),
        }
    }

    async fn get_project(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: IdArgs = parse(args)?;
        let project = Project::find_by_id(&self.pool, args.id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| ApplicationError::not_found(format!("project {}", args.id)))?;
        serialize(project)
    }

    async fn create_project(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: PayloadArgs<CreateProject> = parse(args)?;
        serialize(
            self.deployment
                .project()
                .create_project(&self.pool, self.deployment.repo(), args.payload)
                .await
                .map_err(|error| ApplicationError::bad_request(error.to_string()))?,
        )
    }

    async fn update_project(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: UpdateProjectArgs = parse(args)?;
        let existing = Project::find_by_id(&self.pool, args.id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| ApplicationError::not_found(format!("project {}", args.id)))?;
        serialize(
            self.deployment
                .project()
                .update_project(&self.pool, &existing, args.payload)
                .await
                .map_err(internal_error)?,
        )
    }

    async fn delete_project(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: IdArgs = parse(args)?;
        let deleted = self
            .deployment
            .project()
            .delete_project(&self.pool, args.id)
            .await
            .map_err(internal_error)?;
        if deleted == 0 {
            return Err(ApplicationError::not_found(format!("project {}", args.id)));
        }
        Ok(Value::Null)
    }

    async fn search_project_files(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: SearchProjectArgs = parse(args)?;
        if args.q.trim().is_empty() {
            return Err(ApplicationError::bad_request("query cannot be empty"));
        }
        let repositories = self
            .deployment
            .project()
            .get_repositories(&self.pool, args.id)
            .await
            .map_err(internal_error)?;
        let mode = match args.mode.as_deref() {
            Some("settings") => services::services::file_search::SearchMode::Settings,
            _ => services::services::file_search::SearchMode::TaskForm,
        };
        serialize(
            self.deployment
                .project()
                .search_files(
                    self.deployment.file_search(),
                    &repositories,
                    &services::services::file_search::SearchQuery { q: args.q, mode },
                )
                .await
                .map_err(internal_error)?,
        )
    }

    async fn add_project_repository(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: AddRepoArgs = parse(args)?;
        serialize(
            self.deployment
                .project()
                .add_repository(&self.pool, self.deployment.repo(), args.id, &args.payload)
                .await
                .map_err(|error| ApplicationError::bad_request(error.to_string()))?,
        )
    }

    async fn delete_project_repository(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: DeleteRepoArgs = parse(args)?;
        self.deployment
            .project()
            .delete_repository(&self.pool, args.project_id, args.repo_id)
            .await
            .map_err(internal_error)?;
        Ok(Value::Null)
    }

    async fn register_repo(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: RegisterRepoArgs = parse(args)?;
        serialize(
            self.deployment
                .repo()
                .register(&self.pool, &args.path, args.display_name.as_deref())
                .await
                .map_err(|error| ApplicationError::bad_request(error.to_string()))?,
        )
    }

    async fn init_repo(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: InitRepoArgs = parse(args)?;
        serialize(
            self.deployment
                .repo()
                .init_repo(
                    &self.pool,
                    self.deployment.git(),
                    &args.parent_path,
                    &args.folder_name,
                )
                .await
                .map_err(|error| ApplicationError::bad_request(error.to_string()))?,
        )
    }

    async fn clone_repo(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: CloneRepoArgs = parse(args)?;
        let url = args.clone_url.trim().to_string();
        if url.is_empty() {
            return Err(ApplicationError::bad_request("clone URL cannot be empty"));
        }
        let target = PathBuf::from(&args.target_path);
        let clone_url = url.clone();
        let clone_target = target.clone();
        tokio::task::spawn_blocking(move || {
            git::GitService::clone_repository(&clone_url, &clone_target, None).map(|_| ())
        })
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))?
        .map_err(internal_error)?;
        serialize(
            self.deployment
                .repo()
                .register(&self.pool, &args.target_path, args.display_name.as_deref())
                .await
                .map_err(|error| ApplicationError::bad_request(error.to_string()))?,
        )
    }

    async fn workspace_repos(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: WorkspaceIdArgs = parse(args)?;
        let workspace = self.require_workspace(args.workspace_id).await?;
        let container_ref = self
            .deployment
            .container()
            .ensure_container_exists(&workspace)
            .await
            .map_err(internal_error)?;
        let workspace_root = PathBuf::from(container_ref);
        let repos = WorkspaceRepo::find_repos_with_target_branch_for_workspace(
            &self.pool,
            args.workspace_id,
        )
        .await
        .map_err(internal_error)?;
        serialize(
            repos
                .into_iter()
                .map(|mut repo| {
                    repo.repo.path = workspace
                        .repo_path(&repo.repo)
                        .unwrap_or_else(|| workspace_root.clone());
                    repo
                })
                .collect::<Vec<_>>(),
        )
    }

    async fn session_summaries(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: WorkspaceIdArgs = parse(args)?;
        let sessions = Session::find_by_workspace_id(&self.pool, args.workspace_id)
            .await
            .map_err(internal_error)?;
        let workspace = self.require_workspace(args.workspace_id).await?;
        serialize(
            sessions
                .into_iter()
                .enumerate()
                .map(|(index, session)| {
                    json!({
                        "id": session.id,
                        "workspace_id": session.workspace_id,
                        "task_id": session.task_id,
                        "name": session.name,
                        "display_name": session.name.clone().unwrap_or_else(|| format!("会话{}", index + 1)),
                        "status": session.status,
                        "executor": session.executor,
                        "workspace_name": workspace.name,
                        "workspace_branch": workspace.branch,
                        "created_at": session.created_at,
                        "updated_at": session.updated_at,
                        "first_prompt": session.initial_prompt,
                        "is_running": false,
                        "continuity_mode": "new_session",
                        "pinned_at": Value::Null,
                    })
                })
                .collect::<Vec<_>>(),
        )
    }

    async fn create_session(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: CreateSessionArgs = parse(args)?;
        let workspace = self.require_workspace(args.workspace_id).await?;
        serialize(
            Session::create(
                &self.pool,
                &CreateSession {
                    executor: args.executor,
                    agent_id: None,
                    task_id: args.task_id.or(Some(workspace.task_id)),
                    name: args.name,
                    initial_prompt: args.initial_prompt,
                    status: Some(SessionStatus::Todo),
                },
                Uuid::new_v4(),
                args.workspace_id,
            )
            .await
            .map_err(internal_error)?,
        )
    }

    async fn create_project_root_session(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: CreateProjectRootSessionArgs = parse(args)?;
        let workspace = self.ensure_root_workspace(args.project_id, None).await?;
        serialize(
            Session::create(
                &self.pool,
                &CreateSession {
                    executor: args.executor,
                    agent_id: None,
                    task_id: Some(workspace.task_id),
                    name: args.name,
                    initial_prompt: None,
                    status: Some(SessionStatus::Todo),
                },
                Uuid::new_v4(),
                workspace.id,
            )
            .await
            .map_err(internal_error)?,
        )
    }

    async fn create_project_session(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: PayloadArgs<CreateProjectSessionPayload> = parse(args)?;
        let payload = args.payload;
        let workspace = if let Some(workspace_id) = payload.workspace_id {
            let workspace = self.require_workspace(workspace_id).await?;
            if workspace.project_id != payload.project_id {
                return Err(ApplicationError::bad_request(
                    "workspace does not belong to project",
                ));
            }
            workspace
        } else {
            self.ensure_root_workspace(payload.project_id, payload.branch.as_deref())
                .await?
        };
        self.deployment
            .container()
            .ensure_container_exists(&workspace)
            .await
            .map_err(internal_error)?;
        serialize(
            Session::create(
                &self.pool,
                &CreateSession {
                    executor: payload.executor,
                    agent_id: None,
                    task_id: Some(workspace.task_id),
                    name: payload.name,
                    initial_prompt: payload.initial_prompt,
                    status: Some(SessionStatus::Todo),
                },
                payload.session_id.unwrap_or_else(Uuid::new_v4),
                workspace.id,
            )
            .await
            .map_err(internal_error)?,
        )
    }

    async fn ensure_project_workspace(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: EnsureWorkspaceArgs = parse(args)?;
        serialize(
            self.ensure_root_workspace(args.project_id, args.branch.as_deref())
                .await?,
        )
    }

    async fn rename_session(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: RenameSessionArgs = parse(args)?;
        let _ = self.require_session(args.session_id).await?;
        if let Some(name) = args
            .name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            DbConversationSummary::set_title(&self.pool, args.session_id, name)
                .await
                .map_err(internal_error)?;
        } else {
            Session::update_name(&self.pool, args.session_id, None)
                .await
                .map_err(internal_error)?;
        }
        serialize(self.require_session(args.session_id).await?)
    }

    async fn file_tree(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: FileTreeArgs = parse(args)?;
        let root = self.sandbox_existing_path(&args.root_path).await?;
        if !root.is_dir() {
            return Err(ApplicationError::bad_request(
                "root path is not a directory",
            ));
        }
        serialize(walk_tree(&root, args.depth.unwrap_or(4), 0)?)
    }

    async fn list_directory_children(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: DirectoryChildrenArgs = parse(args)?;
        let root = self.sandbox_existing_path(&args.root_path).await?;
        let target = if args.relative_path.is_empty() {
            root
        } else {
            self.sandbox_existing_path(&root.join(args.relative_path).to_string_lossy())
                .await?
        };
        let mut files = Vec::new();
        let mut directories = Vec::new();
        let mut entries = tokio::fs::read_dir(&target).await.map_err(internal_error)?;
        while let Some(entry) = entries.next_entry().await.map_err(internal_error)? {
            let name = entry.file_name().to_string_lossy().into_owned();
            if SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            if entry.file_type().await.map_err(internal_error)?.is_dir() {
                directories.push(name);
            } else {
                files.push(name);
            }
        }
        Ok(json!({
            "files": files,
            "directories": directories,
            "gitignored_files": [],
            "gitignored_directories": [],
            "truncated": false,
        }))
    }

    async fn read_file_truncated(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: ReadTruncatedArgs = parse(args)?;
        let path = self.sandbox_existing_file(&args.path).await?;
        let bytes = tokio::fs::read(&path).await.map_err(internal_error)?;
        let max = args.max_bytes.unwrap_or(512 * 1024) as usize;
        let truncated = bytes.len() > max;
        let slice = if truncated { &bytes[..max] } else { &bytes };
        Ok(json!({
            "content": String::from_utf8_lossy(slice),
            "truncated": truncated,
            "byteLength": bytes.len(),
        }))
    }

    async fn save_file(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: SaveFileArgs = parse(args)?;
        let path = sanitize_absolute(&args.path)?;
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(internal_error)?;
        }
        tokio::fs::write(path, args.content)
            .await
            .map_err(internal_error)?;
        Ok(Value::Null)
    }

    async fn copy_item(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: PathArgs = parse(args)?;
        let source = self.sandbox_existing_path(&args.path).await?;
        let dest = unique_copy_path(&source)?;
        if source.is_dir() {
            copy_dir(&source, &dest)?;
        } else {
            tokio::fs::copy(&source, &dest)
                .await
                .map_err(internal_error)?;
        }
        serialize(dest.to_string_lossy().into_owned())
    }

    async fn move_item(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: MoveArgs = parse(args)?;
        let source = self.sandbox_existing_path(&args.path).await?;
        let dest = sanitize_absolute(&args.new_path)?;
        tokio::fs::rename(&source, &dest)
            .await
            .map_err(internal_error)?;
        serialize(dest.to_string_lossy().into_owned())
    }

    async fn search_workspace_text(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: TextSearchArgs = parse(args)?;
        let root = self.sandbox_existing_path(&args.root_path).await?;
        let query = args.options.query.to_lowercase();
        let mut files = Vec::new();
        search_text(&root, &query, &mut files, 40)?;
        Ok(json!({ "files": files }))
    }

    async fn create_terminal(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: CreateTerminalArgs = parse(args)?;
        let workspace = self.require_workspace(args.workspace_id).await?;
        let container = self
            .deployment
            .container()
            .ensure_container_exists(&workspace)
            .await
            .map_err(internal_error)?;
        let (session_id, _rx) = self
            .deployment
            .pty()
            .create_session(
                PathBuf::from(container),
                args.cols.unwrap_or(80),
                args.rows.unwrap_or(24),
                args.shell,
                args.session_id,
            )
            .await
            .map_err(internal_error)?;
        serialize(session_id)
    }

    async fn write_terminal(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: WriteTerminalArgs = parse(args)?;
        let bytes = BASE64
            .decode(args.data.as_bytes())
            .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
        self.deployment
            .pty()
            .write(args.session_id, &bytes)
            .await
            .map_err(internal_error)?;
        Ok(Value::Null)
    }

    async fn resize_terminal(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: ResizeTerminalArgs = parse(args)?;
        self.deployment
            .pty()
            .resize(args.session_id, args.cols, args.rows)
            .await
            .map_err(internal_error)?;
        Ok(Value::Null)
    }

    async fn ensure_root_workspace(
        &self,
        project_id: Uuid,
        branch: Option<&str>,
    ) -> Result<Workspace, ApplicationError> {
        let workspaces = Workspace::fetch_by_project_id(&self.pool, project_id)
            .await
            .map_err(internal_error)?;
        if let Some(existing) = select_project_root_workspace(&workspaces, branch).cloned() {
            let _ = self
                .deployment
                .container()
                .ensure_container_exists(&existing)
                .await;
            return Ok(existing);
        }
        let repos = ProjectRepo::find_repos_for_project(&self.pool, project_id)
            .await
            .map_err(internal_error)?;
        let primary = repos
            .into_iter()
            .next()
            .ok_or_else(|| ApplicationError::bad_request("project has no repository"))?;
        let current = self
            .deployment
            .git()
            .get_current_branch(&primary.path)
            .map_err(internal_error)?;
        let branch = branch.unwrap_or(&current).to_string();
        let task = Task::find_by_id(&self.pool, {
            // Seed a workspace from the first project task if one exists.
            sqlx::query_scalar::<_, Uuid>("SELECT id FROM tasks WHERE project_id = ? LIMIT 1")
                .bind(project_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(internal_error)?
                .ok_or_else(|| {
                    ApplicationError::bad_request("project has no task to host a workspace")
                })?
        })
        .await
        .map_err(internal_error)?
        .ok_or_else(|| ApplicationError::not_found("project task"))?;
        Workspace::create(
            &self.pool,
            &db::models::workspace::CreateWorkspace {
                project_id,
                parent_workspace_id: None,
                branch,
                container_ref: Some(primary.path.to_string_lossy().into_owned()),
                use_worktree: false,
                agent_working_dir: None,
            },
            Uuid::new_v4(),
            task.id,
        )
        .await
        .map_err(internal_error)
    }

    pub(crate) async fn require_workspace(&self, workspace_id: Uuid) -> Result<Workspace, ApplicationError> {
        Workspace::find_by_id(&self.pool, workspace_id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| ApplicationError::not_found(format!("workspace {workspace_id}")))
    }

    async fn require_session(&self, session_id: Uuid) -> Result<Session, ApplicationError> {
        Session::find_by_id(&self.pool, session_id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| ApplicationError::not_found(format!("session {session_id}")))
    }

    pub(crate) async fn git_read<T: serde::Serialize>(
        &self,
        path: PathBuf,
        op: impl FnOnce(&git::GitService, &Path) -> Result<T, git::GitServiceError>,
    ) -> Result<Value, ApplicationError> {
        let git = self.deployment.git().clone();
        let value = tokio::task::block_in_place(|| op(&git, &path)).map_err(internal_error)?;
        serialize(value)
    }

    pub(crate) async fn git_write(
        &self,
        path: PathBuf,
        op: impl FnOnce(&git::GitService, &Path) -> Result<(), git::GitServiceError>,
    ) -> Result<Value, ApplicationError> {
        let git = self.deployment.git().clone();
        tokio::task::block_in_place(|| op(&git, &path)).map_err(internal_error)?;
        Ok(Value::Null)
    }

    pub(crate) async fn repo_path(&self, args: RepoIdArgs) -> Result<PathBuf, ApplicationError> {
        Ok(self
            .deployment
            .repo()
            .get_by_id(&self.pool, args.repo_id)
            .await
            .map_err(internal_error)?
            .path)
    }

    pub(crate) async fn worktree_path(&self, args: WorkspaceRepoArgs) -> Result<PathBuf, ApplicationError> {
        let workspace = self.require_workspace(args.workspace_id).await?;
        let repo = self
            .deployment
            .repo()
            .get_by_id(&self.pool, args.repo_id)
            .await
            .map_err(internal_error)?;
        let container = self
            .deployment
            .container()
            .ensure_container_exists(&workspace)
            .await
            .map_err(internal_error)?;
        Ok(workspace
            .repo_path(&repo)
            .unwrap_or_else(|| PathBuf::from(container)))
    }

    pub(crate) async fn sandbox_existing_file(&self, path: &str) -> Result<PathBuf, ApplicationError> {
        let path = self.sandbox_existing_path(path).await?;
        if !path.is_file() {
            return Err(ApplicationError::not_found(format!(
                "file {}",
                path.display()
            )));
        }
        Ok(path)
    }

    async fn sandbox_existing_path(&self, path: &str) -> Result<PathBuf, ApplicationError> {
        let requested = tokio::fs::canonicalize(sanitize_absolute(path)?)
            .await
            .map_err(|_| ApplicationError::not_found(format!("path {path}")))?;
        let roots = self.sandbox_roots().await?;
        if roots.iter().any(|root| requested.starts_with(root)) {
            return Ok(requested);
        }
        Err(ApplicationError::forbidden(
            "path is outside every registered repository or workspace",
        ))
    }

    async fn sandbox_roots(&self) -> Result<Vec<PathBuf>, ApplicationError> {
        let mut roots = HashSet::new();
        for path in sqlx::query_scalar::<_, String>("SELECT path FROM repos")
            .fetch_all(&self.pool)
            .await
            .map_err(internal_error)?
        {
            if let Ok(path) = tokio::fs::canonicalize(path).await {
                roots.insert(path);
            }
        }
        for path in sqlx::query_scalar::<_, Option<String>>(
            "SELECT container_ref FROM workspaces WHERE container_ref IS NOT NULL",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(internal_error)?
        .into_iter()
        .flatten()
        {
            if let Ok(path) = tokio::fs::canonicalize(path).await {
                roots.insert(path);
            }
        }
        Ok(roots.into_iter().collect())
    }
}

fn select_project_root_workspace<'a>(
    workspaces: &'a [Workspace],
    branch: Option<&str>,
) -> Option<&'a Workspace> {
    let active = workspaces
        .iter()
        .filter(|workspace| !workspace.archived)
        .collect::<Vec<_>>();
    let matches_branch =
        |workspace: &&Workspace| branch.is_none_or(|wanted| workspace.branch == wanted);
    active
        .iter()
        .copied()
        .find(|workspace| !workspace.use_worktree && matches_branch(workspace))
        .or_else(|| {
            active
                .iter()
                .copied()
                .find(|workspace| !workspace.use_worktree)
        })
}

pub(crate) fn sanitize_absolute(path: &str) -> Result<PathBuf, ApplicationError> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err(ApplicationError::bad_request(
            "only absolute paths are accepted",
        ));
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(ApplicationError::bad_request(
            "path traversal is not allowed",
        ));
    }
    Ok(path)
}

fn walk_tree(root: &Path, max_depth: u32, depth: u32) -> Result<Vec<Value>, ApplicationError> {
    let mut entries = Vec::new();
    let read = std::fs::read_dir(root).map_err(internal_error)?;
    for entry in read {
        let entry = entry.map_err(internal_error)?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        let path = entry.path();
        let is_dir = path.is_dir();
        let children = if is_dir && depth + 1 < max_depth {
            Some(walk_tree(&path, max_depth, depth + 1)?)
        } else {
            None
        };
        entries.push(json!({
            "name": name,
            "path": path.to_string_lossy(),
            "is_dir": is_dir,
            "children": children,
            "git_status": Value::Null,
        }));
    }
    Ok(entries)
}

fn unique_copy_path(source: &Path) -> Result<PathBuf, ApplicationError> {
    let parent = source
        .parent()
        .ok_or_else(|| ApplicationError::internal("cannot copy filesystem root"))?;
    let stem = source
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    let ext = source
        .extension()
        .map(|ext| format!(".{}", ext.to_string_lossy()))
        .unwrap_or_default();
    for index in 0..100 {
        let suffix = if index == 0 {
            "_copy".to_string()
        } else {
            format!("_copy_{}", index + 1)
        };
        let dest = parent.join(format!("{stem}{suffix}{ext}"));
        if !dest.exists() {
            return Ok(dest);
        }
    }
    Err(ApplicationError::conflict("too many copies exist"))
}

fn copy_dir(source: &Path, dest: &Path) -> Result<(), ApplicationError> {
    std::fs::create_dir_all(dest).map_err(internal_error)?;
    for entry in std::fs::read_dir(source).map_err(internal_error)? {
        let entry = entry.map_err(internal_error)?;
        let to = dest.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), to).map_err(internal_error)?;
        }
    }
    Ok(())
}

fn search_text(
    root: &Path,
    query: &str,
    files: &mut Vec<Value>,
    remaining: usize,
) -> Result<(), ApplicationError> {
    if remaining == 0 || query.is_empty() {
        return Ok(());
    }
    let mut leftover = remaining;
    let read = std::fs::read_dir(root).map_err(internal_error)?;
    for entry in read {
        if leftover == 0 {
            break;
        }
        let entry = entry.map_err(internal_error)?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        if path.is_dir() {
            search_text(&path, query, files, leftover)?;
            leftover = remaining.saturating_sub(files.len());
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let matches = content
            .lines()
            .enumerate()
            .filter(|(_, line)| line.to_lowercase().contains(query))
            .take(8)
            .map(|(line, text)| json!({ "line": line + 1, "text": text }))
            .collect::<Vec<_>>();
        if !matches.is_empty() {
            files.push(json!({
                "path": path.to_string_lossy(),
                "matches": matches,
            }));
            leftover = leftover.saturating_sub(1);
        }
    }
    Ok(())
}

#[derive(Deserialize)]
struct IdArgs {
    id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RepoIdArgs {
    pub(crate) repo_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectIdArgs {
    project_id: Uuid,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OptionalTaskArgs {
    task_id: Option<Uuid>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceIdArgs {
    workspace_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionIdArgs {
    session_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentIdArgs {
    agent_id: String,
}

#[derive(Deserialize)]
struct PayloadArgs<T> {
    payload: T,
}

#[derive(Deserialize)]
struct UpdateProjectArgs {
    id: Uuid,
    payload: UpdateProject,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchProjectArgs {
    id: Uuid,
    q: String,
    mode: Option<String>,
}

#[derive(Deserialize)]
struct AddRepoArgs {
    id: Uuid,
    payload: CreateProjectRepo,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteRepoArgs {
    project_id: Uuid,
    repo_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterRepoArgs {
    path: String,
    display_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InitRepoArgs {
    parent_path: String,
    folder_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloneRepoArgs {
    clone_url: String,
    target_path: String,
    display_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepoFileArgs {
    repo_id: Uuid,
    file_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepoCommitArgs {
    repo_id: Uuid,
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepoBranchArgs {
    repo_id: Uuid,
    branch: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceRepoArgs {
    pub(crate) workspace_id: Uuid,
    pub(crate) repo_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceFileArgs {
    workspace_id: Uuid,
    repo_id: Uuid,
    file_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceCommitArgs {
    workspace_id: Uuid,
    repo_id: Uuid,
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceCommitDetailArgs {
    workspace_id: Uuid,
    repo_id: Uuid,
    sha: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceBranchArgs {
    workspace_id: Uuid,
    repo_id: Uuid,
    branch: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateSessionArgs {
    workspace_id: Uuid,
    executor: Option<String>,
    name: Option<String>,
    initial_prompt: Option<String>,
    task_id: Option<Uuid>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateProjectRootSessionArgs {
    project_id: Uuid,
    executor: Option<String>,
    name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateProjectSessionPayload {
    session_id: Option<Uuid>,
    project_id: Uuid,
    workspace_id: Option<Uuid>,
    branch: Option<String>,
    executor: Option<String>,
    name: Option<String>,
    initial_prompt: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnsureWorkspaceArgs {
    project_id: Uuid,
    branch: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameSessionArgs {
    session_id: Uuid,
    name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionStatusArgs {
    session_id: Uuid,
    status: SessionStatus,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionPinnedArgs {
    session_id: Uuid,
    pinned: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathArgs {
    path: String,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OptionalPathArgs {
    path: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileTreeArgs {
    root_path: String,
    depth: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirectoryChildrenArgs {
    root_path: String,
    relative_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadTruncatedArgs {
    path: String,
    max_bytes: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveFileArgs {
    path: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MoveArgs {
    path: String,
    new_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileAtHeadArgs {
    file_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TextSearchArgs {
    root_path: String,
    options: TextSearchOptions,
}

#[derive(Deserialize)]
struct TextSearchOptions {
    query: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateTerminalArgs {
    workspace_id: Uuid,
    cols: Option<u16>,
    rows: Option<u16>,
    shell: Option<String>,
    session_id: Option<Uuid>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalSessionArgs {
    session_id: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WriteTerminalArgs {
    session_id: Uuid,
    data: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResizeTerminalArgs {
    session_id: Uuid,
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentEnabledArgs {
    agent_id: String,
    enabled: bool,
}
