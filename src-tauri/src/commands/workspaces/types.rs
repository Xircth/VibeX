use std::path::Path;

use db::models::{
    execution_process::ExecutionProcess,
    merge::{Merge, MergeStatus},
    task::Task,
    workspace::Workspace,
};
use executors::profile::ExecutorProfileId;
use git::ConflictOp;
use serde::{Deserialize, Serialize};
use services::services::git_host::ProviderKind;
use uuid::Uuid;

pub(crate) fn detect_package_manager(repo_root: &Path) -> (&'static str, Vec<&'static str>) {
    if repo_root.join("pnpm-lock.yaml").exists() {
        return ("pnpm", vec!["add", "vibex-web-companion"]);
    }

    if repo_root.join("yarn.lock").exists() {
        return ("yarn", vec!["add", "vibex-web-companion"]);
    }

    if repo_root.join("bun.lockb").exists() || repo_root.join("bun.lock").exists() {
        return ("bun", vec!["add", "vibex-web-companion"]);
    }

    ("npm", vec!["i", "vibex-web-companion"])
}

// --- Local request/response types ---

#[derive(Debug, Deserialize)]
pub struct WorkspaceRepoInput {
    pub repo_id: Uuid,
    pub target_branch: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateWorkspaceRequest {
    pub task_id: Uuid,
    pub executor_profile_id: ExecutorProfileId,
    pub repos: Vec<WorkspaceRepoInput>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateWorkspaceRequest {
    pub archived: Option<bool>,
    pub pinned: Option<bool>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchStatus {
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
    pub conflict_op: Option<ConflictOp>,
    pub conflicted_files: Vec<String>,
    pub is_target_remote: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RepoBranchStatus {
    pub repo_id: Uuid,
    pub repo_name: String,
    #[serde(flatten)]
    pub status: BranchStatus,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GitOperationError {
    MergeConflicts {
        message: String,
        op: ConflictOp,
        conflicted_files: Vec<String>,
        target_branch: String,
    },
    RebaseInProgress,
}

#[derive(Debug, Serialize)]
pub struct ChangeTargetBranchResponse {
    pub repo_id: Uuid,
    pub new_target_branch: String,
    pub status: (usize, usize),
}

#[derive(Debug, Serialize)]
pub struct RenameBranchResponse {
    pub branch: String,
}

#[derive(Debug, Serialize)]
pub struct OpenEditorResponse {
    pub url: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PushError {
    ForcePushRequired,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RunScriptError {
    NoScriptConfigured,
    ProcessAlreadyRunning,
}

#[derive(Debug, Serialize)]
pub struct RunScriptResult {
    pub process: Option<ExecutionProcess>,
    pub error: Option<RunScriptError>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PrError {
    CliNotInstalled { provider: ProviderKind },
    CliNotLoggedIn { provider: ProviderKind },
    GitCliNotLoggedIn,
    GitCliNotInstalled,
    TargetBranchNotFound { branch: String },
    UnsupportedProvider,
}

#[derive(Debug, Serialize)]
pub struct CreatePrResult {
    pub url: Option<String>,
    pub error: Option<PrError>,
}

#[derive(Debug, Serialize)]
pub struct AttachPrResponse {
    pub pr_attached: bool,
    pub pr_url: Option<String>,
    pub pr_number: Option<i64>,
    pub pr_status: Option<MergeStatus>,
}

#[derive(Debug, Serialize)]
pub struct AttachPrResult {
    pub response: Option<AttachPrResponse>,
    pub error: Option<PrError>,
}

#[derive(Debug, Serialize)]
pub struct PrCommentsResponse {
    pub comments: Vec<services::services::git_host::UnifiedPrComment>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GetPrCommentsError {
    NoPrAttached,
    CliNotInstalled { provider: ProviderKind },
    CliNotLoggedIn { provider: ProviderKind },
}

#[derive(Debug, Serialize)]
pub struct PrCommentsResult {
    pub response: Option<PrCommentsResponse>,
    pub error: Option<GetPrCommentsError>,
}

#[derive(Debug, Deserialize)]
pub struct CreateWorkspaceFromPrRequest {
    pub repo_id: Uuid,
    pub pr_number: i64,
    pub pr_title: String,
    pub pr_url: String,
    pub head_branch: String,
    pub base_branch: String,
    pub run_setup: bool,
    pub remote_name: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CreateWorkspaceFromPrResponse {
    pub workspace: Workspace,
    pub task: Task,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CreateFromPrError {
    PrNotFound,
    BranchFetchFailed { message: String },
    CliNotInstalled { provider: ProviderKind },
    AuthFailed { message: String },
    UnsupportedProvider,
    RepoNotInProject,
}

#[derive(Debug, Serialize)]
pub struct CreateFromPrResult {
    pub response: Option<CreateWorkspaceFromPrResponse>,
    pub error: Option<CreateFromPrError>,
}

#[derive(Debug, Serialize, Deserialize)]
pub enum GhCliSetupError {
    BrewMissing,
    SetupHelperNotSupported,
    Other { message: String },
}

#[derive(Debug, Serialize)]
pub struct GhCliSetupResult {
    pub process: Option<ExecutionProcess>,
    pub error: Option<GhCliSetupError>,
}

#[derive(Debug, Serialize)]
pub struct RebaseResult {
    pub error: Option<GitOperationError>,
}

#[derive(Debug, Serialize)]
pub struct PushResult {
    pub error: Option<PushError>,
}
