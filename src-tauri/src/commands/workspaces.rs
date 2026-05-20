use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

use db::models::{
    coding_agent_turn::CodingAgentTurn,
    execution_process::{ExecutionProcess, ExecutionProcessRunReason, ExecutionProcessStatus},
    merge::{Merge, MergeStatus, PrMerge, PullRequestInfo},
    project_repo::ProjectRepo,
    repo::{Repo, RepoError},
    session::{CreateSession, Session, SessionStatus},
    task::{CreateTask, Task, TaskRelationships, TaskStatus},
    workspace::{CreateWorkspace, Workspace},
    workspace_repo::{CreateWorkspaceRepo, RepoWithTargetBranch, WorkspaceRepo},
};
use deployment::Deployment;
use executors::{
    actions::{
        ExecutorAction, ExecutorActionType,
        coding_agent_follow_up::CodingAgentFollowUpRequest,
        coding_agent_initial::CodingAgentInitialRequest,
        script::{ScriptContext, ScriptRequest, ScriptRequestLanguage},
    },
    executors::{ExecutorError, StandardCodingAgentExecutor},
    profile::{ExecutorConfig, ExecutorConfigs, ExecutorProfileId},
};
use git::{ConflictOp, GitCli, GitCliError, GitRemote, GitService, GitServiceError};
use git2::BranchType;
use serde::{Deserialize, Serialize};
use services::services::{
    config::DEFAULT_PR_DESCRIPTION_PROMPT,
    container::ContainerService,
    git_host::{self, CreatePrRequest, GitHostError, GitHostProvider, ProviderKind, github::GhCli},
    workspace_manager::WorkspaceManager,
};
use utils::shell::resolve_executable_path;
use uuid::Uuid;

use crate::{
    error::AppError,
    state::AppState,
    workspace_paths::{
        resolve_workspace_agent_working_dir, resolve_workspace_default_open_path,
        resolve_workspace_repo_root, resolve_workspace_repo_script_working_dir,
    },
};

include!("workspaces/types.rs");
include!("workspaces/workspace_sync.rs");
include!("workspaces/workspace_crud.rs");
include!("workspaces/git_operations.rs");
include!("workspaces/workspace_scripts.rs");
include!("workspaces/workspace_queries.rs");
include!("workspaces/pull_requests.rs");
include!("workspaces/pr_import.rs");
include!("workspaces/commit_commands.rs");
