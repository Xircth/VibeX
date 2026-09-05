mod file_listing;
mod file_search;

use std::{
    collections::HashSet,
    path::{Component, Path, PathBuf},
};

use agents::{AgentId, AgentSessionId};
use application::{ApplicationError, DomainCommand};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use db::models::{
    conversation::DbConversationSummary,
    conversation_turn::ConversationTurnRecord,
    project::{CreateProject, Project, UpdateProject},
    project_repo::{CreateProjectRepo, ProjectRepo},
    repo::Repo,
    session::{CreateSession, Session, SessionStatus},
    task::{CreateTask, Task, TaskStatus},
    workspace::{CreateWorkspace, Workspace},
    workspace_repo::{CreateWorkspaceRepo, WorkspaceRepo},
};
use deployment::Deployment;
use file_listing::{build_git_status_map, list_directory_children_at_path, walk_file_tree};
use file_search::{TextSearchOptions, search_workspace_text_at_path};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::domains::{ServerApplicationDomains, internal_error, parse, serialize};

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
                    |git, path| git.create_branch(path, &args.branch, args.from_ref.as_deref()),
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
                    |git, path| git.create_branch(path, &args.branch, args.from_ref.as_deref()),
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
            DomainCommand::SessionDelete => self.delete_session(args).await,
            DomainCommand::FileTree => self.file_tree(args).await,
            DomainCommand::FileRead => {
                let args: PathArgs = parse(args)?;
                let path = self.sandbox_existing_file(&args.path).await?;
                let bytes = tokio::fs::read(&path).await.map_err(internal_error)?;
                if bytes.contains(&0) {
                    return Err(ApplicationError::bad_request(
                        "Binary files cannot be opened as text",
                    ));
                }
                serialize(
                    String::from_utf8(bytes).map_err(|_| {
                        ApplicationError::bad_request("File is not valid UTF-8 text")
                    })?,
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
                serialize(file_at_head_content(&args.file_path)?)
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
        let in_flight = ConversationTurnRecord::in_flight_conversation_ids_for_workspace(
            &self.pool,
            args.workspace_id,
        )
        .await
        .map_err(internal_error)?;
        let pinned_rows: Vec<(Uuid, Option<chrono::DateTime<chrono::Utc>>)> =
            sqlx::query_as(r#"SELECT id, pinned_at FROM sessions WHERE workspace_id = ?"#)
                .bind(args.workspace_id)
                .fetch_all(&self.pool)
                .await
                .map_err(internal_error)?;
        let pinned_at_by_id = pinned_rows
            .into_iter()
            .collect::<std::collections::HashMap<_, _>>();
        let mut fallback_number = 0usize;
        serialize(
            sessions
                .into_iter()
                .map(|session| {
                    let first_prompt = session.initial_prompt.clone();
                    let needs_fallback = session
                        .name
                        .as_deref()
                        .is_none_or(|value| value.trim().is_empty())
                        && first_prompt
                            .as_deref()
                            .is_none_or(|value| value.trim().is_empty());
                    if needs_fallback {
                        fallback_number += 1;
                    }
                    json!({
                        "id": session.id,
                        "workspace_id": session.workspace_id,
                        "task_id": session.task_id,
                        "name": session.name,
                        "display_name": session_display_name(&session, first_prompt.as_deref(), fallback_number),
                        "status": session.status,
                        "executor": session.executor,
                        "agent_id": session.agent_id,
                        "workspace_name": workspace.name,
                        "workspace_branch": workspace.branch,
                        "created_at": session.created_at,
                        "updated_at": session.updated_at,
                        "first_prompt": first_prompt,
                        "is_running": in_flight.contains(&session.id),
                        "continuity_mode": "new_session",
                        "pinned_at": pinned_at_by_id.get(&session.id).copied().flatten(),
                    })
                })
                .collect::<Vec<_>>(),
        )
    }

    async fn create_session(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: CreateSessionArgs = parse(args)?;
        let workspace = self.require_workspace(args.workspace_id).await?;
        self.deployment
            .container()
            .ensure_container_exists(&workspace)
            .await
            .map_err(internal_error)?;
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
        self.deployment
            .container()
            .ensure_container_exists(&workspace)
            .await
            .map_err(internal_error)?;
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

    async fn delete_session(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: SessionIdArgs = parse(args)?;
        let session = self.require_session(args.session_id).await?;
        if db::models::execution_process::ExecutionProcess::has_running_non_dev_server_processes_for_session(
            &self.pool,
            session.id,
        )
        .await
        .map_err(internal_error)?
        {
            return Err(ApplicationError::conflict("会话仍在执行，无法删除"));
        }
        let _ = db::models::scratch::Scratch::delete_all_by_id(&self.pool, session.id).await;
        let deleted = Session::delete(&self.pool, session.id)
            .await
            .map_err(internal_error)?;
        if deleted == 0 {
            return Err(ApplicationError::not_found(format!(
                "session {}",
                session.id
            )));
        }
        if let Ok(mut conn) = self.pool.acquire().await
            && let Err(error) =
                conversations::search::delete_from_index(&mut conn, session.id).await
        {
            tracing::warn!("failed to remove conversation from search index: {error}");
        }
        Ok(Value::Null)
    }

    async fn create_project_session(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: PayloadArgs<CreateProjectSessionPayload> = parse(args)?;
        let payload = args.payload;
        let workspace = if payload.create_workspace.unwrap_or(false) {
            self.create_worktree_workspace_for_project_session(
                payload.project_id,
                payload.name.as_deref(),
                payload.initial_prompt.as_deref(),
                payload.repos.as_deref().unwrap_or(&[]),
            )
            .await?
        } else if let Some(workspace_id) = payload.workspace_id {
            let workspace = self.require_workspace(workspace_id).await?;
            if workspace.project_id != payload.project_id {
                return Err(ApplicationError::bad_request(
                    "workspace does not belong to project",
                ));
            }
            let repos = ProjectRepo::find_repos_for_project(&self.pool, payload.project_id)
                .await
                .map_err(internal_error)?;
            if payload.session_id.is_some() {
                workspace
            } else if workspace_container_overlaps_repo(&workspace, &repos)
                || !workspace.use_worktree
            {
                self.ensure_root_workspace(payload.project_id, Some(workspace.branch.as_str()))
                    .await?
            } else {
                workspace
            }
        } else {
            self.ensure_root_workspace(payload.project_id, payload.branch.as_deref())
                .await?
        };
        self.deployment
            .container()
            .ensure_container_exists(&workspace)
            .await
            .map_err(internal_error)?;
        let session_id = payload.session_id.unwrap_or_else(Uuid::new_v4);
        let prepared_identity = if payload.session_id.is_some() {
            let agent_id = prepared_session_agent_id(payload.executor.as_deref())?;
            let prepared = self
                .conversations
                .agent_runtime
                .claim_prepared_session(AgentSessionId(session_id), workspace.id, agent_id.clone())
                .await
                .map_err(|error| ApplicationError::bad_request(error.to_string()))?;
            Some((agent_id, prepared))
        } else {
            None
        };
        let mut session = Session::create(
            &self.pool,
            &CreateSession {
                executor: payload.executor,
                agent_id: prepared_identity
                    .as_ref()
                    .map(|(agent_id, _)| agent_id.clone()),
                task_id: Some(workspace.task_id),
                name: payload.name,
                initial_prompt: payload.initial_prompt,
                status: Some(SessionStatus::Todo),
            },
            session_id,
            workspace.id,
        )
        .await
        .map_err(internal_error)?;
        if let Some((agent_id, prepared)) = prepared_identity {
            Session::update_agent_metadata(
                &self.pool,
                session.id,
                Some(&prepared.acp_session_id),
                Some(&agent_id),
            )
            .await
            .map_err(internal_error)?;
            session.external_session_id = Some(prepared.acp_session_id);
            session.agent_id = Some(agent_id);
        }
        self.conversations
            .agent_runtime
            .commit_prepared_session(AgentSessionId(session_id))
            .await;
        serialize(session)
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
        let git_map = build_git_status_map(&root);
        serialize(walk_file_tree(
            &root,
            args.depth.unwrap_or(10),
            0,
            &git_map,
        )?)
    }

    async fn list_directory_children(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: DirectoryChildrenArgs = parse(args)?;
        let root = self.sandbox_existing_path(&args.root_path).await?;
        if !args.relative_path.is_empty() {
            self.sandbox_existing_path(&root.join(&args.relative_path).to_string_lossy())
                .await?;
        }
        let listing = tokio::task::spawn_blocking(move || {
            list_directory_children_at_path(&root, &args.relative_path)
        })
        .await
        .map_err(|error| ApplicationError::internal(error.to_string()))??;
        serialize(listing)
    }

    async fn read_file_truncated(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: ReadTruncatedArgs = parse(args)?;
        let path = self.sandbox_existing_file(&args.path).await?;
        let bytes = tokio::fs::read(&path).await.map_err(internal_error)?;
        if bytes.contains(&0) {
            return Err(ApplicationError::bad_request(
                "Binary files cannot be opened as text",
            ));
        }
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
        if let Some(parent) = path.parent()
            && !parent.exists()
        {
            return Err(ApplicationError::not_found(format!(
                "Parent directory does not exist: {}",
                parent.display()
            )));
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
        if source == dest {
            return serialize(dest.to_string_lossy().into_owned());
        }
        if dest.exists() {
            return Err(ApplicationError::conflict(format!(
                "Destination already exists: {}",
                dest.display()
            )));
        }
        let dest_parent = dest.parent().ok_or_else(|| {
            ApplicationError::bad_request("Destination must include a parent directory")
        })?;
        if !dest_parent.exists() {
            return Err(ApplicationError::not_found(format!(
                "Destination parent does not exist: {}",
                dest_parent.display()
            )));
        }
        if source.is_dir() && dest.starts_with(&source) {
            return Err(ApplicationError::bad_request(
                "Cannot move a directory into itself",
            ));
        }
        tokio::fs::rename(&source, &dest)
            .await
            .map_err(internal_error)?;
        serialize(dest.to_string_lossy().into_owned())
    }

    async fn search_workspace_text(&self, args: Value) -> Result<Value, ApplicationError> {
        let args: TextSearchArgs = parse(args)?;
        let root = self.sandbox_existing_path(&args.root_path).await?;
        serialize(search_workspace_text_at_path(&root, args.options)?)
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
        let repos = ProjectRepo::find_repos_for_project(&self.pool, project_id)
            .await
            .map_err(internal_error)?;
        let primary = repos
            .into_iter()
            .next()
            .ok_or_else(|| ApplicationError::bad_request("Project has no repositories"))?;
        let current_branch = self
            .deployment
            .git()
            .get_current_branch(&primary.path)
            .map_err(internal_error)?;
        let desired_branch = branch
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| current_branch.clone());
        if desired_branch != current_branch {
            self.deployment
                .git()
                .checkout_branch(&primary.path, &desired_branch)
                .map_err(|error| {
                    if git_checkout_error_is_local_changes(&error.to_string()) {
                        ApplicationError::bad_request(format!(
                            "当前分支{current_branch}中存在未提交更改，无法切换到{desired_branch}分支，请先提交或放弃更改。"
                        ))
                    } else {
                        ApplicationError::internal(format!(
                            "Failed to checkout project root branch '{desired_branch}': {error}"
                        ))
                    }
                })?;
        }
        let workspace_repos = vec![CreateWorkspaceRepo {
            repo_id: primary.id,
            target_branch: desired_branch.clone(),
        }];
        if let Some(workspace_id) = WorkspaceRepo::find_reusable_non_worktree_workspace_id(
            &self.pool,
            project_id,
            &workspace_repos,
        )
        .await
        .map_err(internal_error)?
            && let Some(mut workspace) = Workspace::find_by_id(&self.pool, workspace_id)
                .await
                .map_err(internal_error)?
        {
            let expected_container_ref = primary.path.to_string_lossy().into_owned();
            if workspace.container_ref.as_deref() != Some(expected_container_ref.as_str()) {
                Workspace::update_container_ref(&self.pool, workspace.id, &expected_container_ref)
                    .await
                    .map_err(internal_error)?;
                workspace.container_ref = Some(expected_container_ref);
            }
            if workspace.agent_working_dir != primary.default_working_dir {
                sqlx::query(
                    "UPDATE workspaces SET agent_working_dir = ?, updated_at = datetime('now', 'subsec') WHERE id = ?",
                )
                .bind(primary.default_working_dir.as_deref())
                .bind(workspace.id)
                .execute(&self.pool)
                .await
                .map_err(internal_error)?;
                workspace.agent_working_dir = primary.default_working_dir.clone();
            }
            let _ = self
                .deployment
                .container()
                .ensure_container_exists(&workspace)
                .await;
            return Ok(workspace);
        }
        let owner_task = if let Some(task) =
            Task::find_by_project_id_with_attempt_status(&self.pool, project_id)
                .await
                .map_err(internal_error)?
                .into_iter()
                .map(|task| task.task)
                .next()
        {
            task
        } else {
            Task::create(
                &self.pool,
                &CreateTask {
                    project_id,
                    title: format!("Project Root Workspace ({})", primary.name),
                    description: Some(
                        "Auto-created to support sessions on the project root branch.".to_string(),
                    ),
                    status: Some(TaskStatus::Todo),
                    parent_workspace_id: None,
                    image_ids: None,
                },
                Uuid::new_v4(),
            )
            .await
            .map_err(internal_error)?
        };
        let workspace = Workspace::create(
            &self.pool,
            &CreateWorkspace {
                project_id,
                parent_workspace_id: None,
                branch: desired_branch.clone(),
                container_ref: Some(primary.path.to_string_lossy().into_owned()),
                use_worktree: false,
                agent_working_dir: primary.default_working_dir.clone(),
            },
            Uuid::new_v4(),
            owner_task.id,
        )
        .await
        .map_err(internal_error)?;
        WorkspaceRepo::create_many(&self.pool, workspace.id, &workspace_repos)
            .await
            .map_err(internal_error)?;
        let workspace_display_name = if primary.display_name.trim().is_empty() {
            primary.name.as_str()
        } else {
            primary.display_name.as_str()
        };
        let workspace_name = format!("{workspace_display_name} · {desired_branch}");
        Workspace::update(
            &self.pool,
            workspace.id,
            Some(false),
            None,
            Some(workspace_name.as_str()),
        )
        .await
        .map_err(internal_error)?;
        let workspace = Workspace::find_by_id(&self.pool, workspace.id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| ApplicationError::not_found(format!("workspace {}", workspace.id)))?;
        let _ = self
            .deployment
            .container()
            .ensure_container_exists(&workspace)
            .await;
        Ok(workspace)
    }

    async fn create_worktree_workspace_for_project_session(
        &self,
        project_id: Uuid,
        name: Option<&str>,
        initial_prompt: Option<&str>,
        repos: &[ProjectSessionRepoInput],
    ) -> Result<Workspace, ApplicationError> {
        if repos.is_empty() {
            return Err(ApplicationError::bad_request(
                "At least one repository is required",
            ));
        }
        let workspace_title = derive_workspace_seed_title(name, initial_prompt);
        let task = Task::create(
            &self.pool,
            &CreateTask {
                project_id,
                title: workspace_title.clone(),
                description: initial_prompt.map(ToOwned::to_owned),
                status: Some(TaskStatus::Todo),
                parent_workspace_id: None,
                image_ids: None,
            },
            Uuid::new_v4(),
        )
        .await
        .map_err(internal_error)?;
        let agent_working_dir = if repos.len() == 1 {
            let repo = Repo::find_by_id(&self.pool, repos[0].repo_id)
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
        let workspace_id = Uuid::new_v4();
        let branch = self
            .deployment
            .container()
            .git_branch_from_workspace(&workspace_id, &workspace_title)
            .await;
        let workspace = Workspace::create(
            &self.pool,
            &CreateWorkspace {
                project_id,
                parent_workspace_id: None,
                branch,
                container_ref: None,
                use_worktree: true,
                agent_working_dir,
            },
            workspace_id,
            task.id,
        )
        .await
        .map_err(internal_error)?;
        Workspace::update(
            &self.pool,
            workspace.id,
            None,
            None,
            Some(workspace_title.as_str()),
        )
        .await
        .map_err(internal_error)?;
        let mut workspace_repos = Vec::with_capacity(repos.len());
        for input in repos {
            let target_branch = if input.target_branch.trim().is_empty() {
                let repo = Repo::find_by_id(&self.pool, input.repo_id)
                    .await
                    .map_err(internal_error)?
                    .ok_or_else(|| ApplicationError::not_found("repository not found"))?;
                self.deployment
                    .git()
                    .get_current_branch(&repo.path)
                    .map_err(|error| {
                        ApplicationError::internal(format!(
                            "Could not resolve the default branch of repo {}: {error}",
                            repo.name
                        ))
                    })?
            } else {
                input.target_branch.clone()
            };
            workspace_repos.push(CreateWorkspaceRepo {
                repo_id: input.repo_id,
                target_branch,
            });
        }
        WorkspaceRepo::create_many(&self.pool, workspace.id, &workspace_repos)
            .await
            .map_err(internal_error)?;
        let workspace = Workspace::find_by_id(&self.pool, workspace.id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| ApplicationError::not_found(format!("workspace {}", workspace.id)))?;
        self.deployment
            .container()
            .ensure_container_exists(&workspace)
            .await
            .map_err(internal_error)?;
        Workspace::find_by_id(&self.pool, workspace.id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| ApplicationError::not_found(format!("workspace {}", workspace.id)))
    }

    pub(crate) async fn require_workspace(
        &self,
        workspace_id: Uuid,
    ) -> Result<Workspace, ApplicationError> {
        Workspace::find_by_id(&self.pool, workspace_id)
            .await
            .map_err(internal_error)?
            .ok_or_else(|| ApplicationError::not_found(format!("workspace {workspace_id}")))
    }

    pub(crate) async fn require_session(
        &self,
        session_id: Uuid,
    ) -> Result<Session, ApplicationError> {
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

    pub(crate) async fn worktree_path(
        &self,
        args: WorkspaceRepoArgs,
    ) -> Result<PathBuf, ApplicationError> {
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

    pub(crate) async fn sandbox_existing_file(
        &self,
        path: &str,
    ) -> Result<PathBuf, ApplicationError> {
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

const NEW_SESSION_WORKSPACE_TITLE: &str = "New Session Workspace";

fn derive_workspace_seed_title(name: Option<&str>, initial_prompt: Option<&str>) -> String {
    if let Some(name) = name.map(str::trim).filter(|name| !name.is_empty()) {
        return name.to_string();
    }
    if let Some(prompt) = initial_prompt
        .map(str::trim)
        .filter(|prompt| !prompt.is_empty())
    {
        return prompt.chars().take(40).collect();
    }
    NEW_SESSION_WORKSPACE_TITLE.to_string()
}

fn prepared_session_agent_id(executor: Option<&str>) -> Result<AgentId, ApplicationError> {
    let executor = executor
        .map(str::trim)
        .filter(|executor| !executor.is_empty())
        .ok_or_else(|| {
            ApplicationError::bad_request("A prepared session requires an Agent executor")
        })?;
    AgentId::parse(executor).map_err(|error| {
        ApplicationError::bad_request(format!(
            "Prepared session Agent executor is invalid: {error}"
        ))
    })
}

fn canonicalize_for_workspace_safety(path: &Path) -> PathBuf {
    if let Ok(path) = std::fs::canonicalize(path) {
        return path;
    }
    let mut missing_segments = Vec::new();
    let mut cursor = path;
    while !cursor.exists() {
        let Some(name) = cursor.file_name() else {
            break;
        };
        missing_segments.push(name.to_os_string());
        let Some(parent) = cursor.parent() else {
            break;
        };
        cursor = parent;
    }
    let mut resolved = std::fs::canonicalize(cursor).unwrap_or_else(|_| cursor.to_path_buf());
    for segment in missing_segments.iter().rev() {
        resolved.push(segment);
    }
    resolved
}

fn workspace_container_overlaps_repo(workspace: &Workspace, repos: &[Repo]) -> bool {
    if !workspace.use_worktree {
        return false;
    }
    let Some(container_ref) = workspace.container_ref.as_deref() else {
        return false;
    };
    let container_path = canonicalize_for_workspace_safety(Path::new(container_ref));
    repos.iter().any(|repo| {
        let repo_path = canonicalize_for_workspace_safety(&repo.path);
        container_path == repo_path
            || container_path.starts_with(&repo_path)
            || repo_path.starts_with(&container_path)
    })
}

fn git_checkout_error_is_local_changes(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    normalized.contains("local changes") && normalized.contains("would be overwritten by checkout")
}

fn file_at_head_content(file_path: &str) -> Result<String, ApplicationError> {
    let path = sanitize_absolute(file_path)?;
    let repo = git2::Repository::discover(&path)
        .map_err(|error| ApplicationError::internal(format!("Failed to open git repo: {error}")))?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| ApplicationError::internal("Bare repository has no working directory"))?;
    let workdir = workdir.canonicalize().map_err(internal_error)?;
    let relative = path.strip_prefix(&workdir).map_err(|_| {
        ApplicationError::bad_request(format!(
            "File {file_path} is not within the repository working directory"
        ))
    })?;
    let commit = repo
        .head()
        .and_then(|head| head.peel_to_commit())
        .map_err(|error| ApplicationError::internal(format!("Failed to get HEAD: {error}")))?;
    let tree = commit.tree().map_err(|error| {
        ApplicationError::internal(format!("Failed to get commit tree: {error}"))
    })?;
    let git_path = relative.to_string_lossy().replace('\\', "/");
    let tree_entry = tree
        .get_path(Path::new(&git_path))
        .map_err(|_| ApplicationError::not_found(format!("File not found in HEAD: {git_path}")))?;
    let blob = repo
        .find_blob(tree_entry.id())
        .map_err(|error| ApplicationError::internal(format!("Failed to read blob: {error}")))?;
    if blob.is_binary() {
        return Err(ApplicationError::bad_request(format!(
            "Binary file cannot be opened as text: {git_path}"
        )));
    }
    std::str::from_utf8(blob.content())
        .map(str::to_string)
        .map_err(|_| {
            ApplicationError::bad_request(format!(
                "Binary file cannot be opened as text: {git_path}"
            ))
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

fn session_display_name(
    session: &Session,
    first_prompt: Option<&str>,
    fallback_number: usize,
) -> String {
    session
        .name
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .or_else(|| {
            first_prompt
                .map(|value| value.split_whitespace().collect::<Vec<_>>().join(" "))
                .filter(|value| !value.is_empty())
                .map(|value| value.chars().take(8).collect())
        })
        .unwrap_or_else(|| format!("新会话{fallback_number}"))
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
    #[serde(alias = "branchName")]
    branch: String,
    #[serde(default)]
    from_ref: Option<String>,
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
    #[serde(alias = "branchName")]
    branch: String,
    #[serde(default)]
    from_ref: Option<String>,
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
    #[serde(default, alias = "session_id")]
    session_id: Option<Uuid>,
    #[serde(alias = "project_id")]
    project_id: Uuid,
    #[serde(default, alias = "workspace_id")]
    workspace_id: Option<Uuid>,
    #[serde(default)]
    branch: Option<String>,
    #[serde(default)]
    executor: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default, alias = "initial_prompt")]
    initial_prompt: Option<String>,
    #[serde(default, alias = "create_workspace")]
    create_workspace: Option<bool>,
    #[serde(default)]
    repos: Option<Vec<ProjectSessionRepoInput>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSessionRepoInput {
    #[serde(alias = "repo_id")]
    repo_id: Uuid,
    #[serde(alias = "target_branch")]
    target_branch: String,
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

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn create_project_session_payload_accepts_host_camel_case() {
        let parsed: PayloadArgs<CreateProjectSessionPayload> = serde_json::from_value(json!({
            "payload": {
                "projectId": "11111111-1111-1111-1111-111111111111",
                "createWorkspace": true,
                "repos": [{
                    "repoId": "22222222-2222-2222-2222-222222222222",
                    "targetBranch": "main"
                }]
            }
        }))
        .expect("camelCase create session payload");
        assert_eq!(
            parsed.payload.project_id.to_string(),
            "11111111-1111-1111-1111-111111111111"
        );
        assert_eq!(parsed.payload.create_workspace, Some(true));
        assert_eq!(parsed.payload.repos.as_ref().map(Vec::len), Some(1));
    }

    #[test]
    fn create_project_session_payload_accepts_legacy_snake_case() {
        let parsed: PayloadArgs<CreateProjectSessionPayload> = serde_json::from_value(json!({
            "payload": {
                "project_id": "11111111-1111-1111-1111-111111111111",
                "workspace_id": null,
                "create_workspace": false,
                "repos": [{
                    "repo_id": "22222222-2222-2222-2222-222222222222",
                    "target_branch": "main"
                }]
            }
        }))
        .expect("snake_case create session payload");
        assert_eq!(
            parsed.payload.project_id.to_string(),
            "11111111-1111-1111-1111-111111111111"
        );
        assert_eq!(parsed.payload.create_workspace, Some(false));
        assert_eq!(parsed.payload.repos.unwrap()[0].target_branch, "main");
    }

    #[test]
    fn prepared_sessions_accept_open_registry_agent_ids() {
        let agent_id = prepared_session_agent_id(Some("registry.example-agent")).unwrap();
        assert_eq!(agent_id.as_str(), "registry.example-agent");
    }

    #[test]
    fn prepared_sessions_reject_missing_or_invalid_agent_ids() {
        assert!(prepared_session_agent_id(None).is_err());
    }

    #[test]
    fn repo_branch_args_accept_branch_name_alias() {
        let parsed: RepoBranchArgs = application::decode_command_args(json!({
            "repoId": "11111111-1111-1111-1111-111111111111",
            "branchName": "feat/host"
        }))
        .expect("branchName");
        assert_eq!(parsed.branch, "feat/host");
    }

    #[test]
    fn events_since_unwraps_request() {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct EventsSince {
            conversation_id: String,
            after_sequence: i64,
        }
        let parsed: EventsSince = application::decode_command_args(json!({
            "request": {
                "conversationId": "c-1",
                "afterSequence": 4,
                "limit": 100
            }
        }))
        .expect("request wrap");
        assert_eq!(parsed.conversation_id, "c-1");
        assert_eq!(parsed.after_sequence, 4);
    }

    #[test]
    fn prepared_sessions_reject_invalid_agent_display_names() {
        assert!(prepared_session_agent_id(Some("Registry Agent")).is_err());
    }
}
