import type {
  CreatePrApiRequest,
  CreateTaskAttemptBody,
  ExecutionProcess,
  RepoWithTargetBranch,
  OpenEditorRequest,
  OpenEditorResponse,
  RunAgentSetupRequest,
  RunScriptError,
  PushError,
  PrError,
  PrCommentsResponse,
  MergeTaskAttemptRequest,
  PushTaskAttemptRequest,
  RepoBranchStatus,
  RebaseTaskAttemptRequest,
  ChangeTargetBranchRequest,
  ChangeTargetBranchResponse,
  RenameBranchResponse,
  AbortConflictsRequest,
  ContinueRebaseRequest,
  TaskRelationships,
  Workspace,
  CreateWorkspaceFromPrBody,
  CreateWorkspaceFromPrResponse,
  DetailedGitStatus,
  GitFileDiffEntry,
  GitLogStatus,
  CommitDetail,
  ResetMode,
  Diff,
} from 'shared/types';

import type { WorkspaceWithSession } from '@/types/attempt';
import { createWorkspaceWithSession } from '@/types/attempt';
import { tauriInvoke, invokeAsResult } from './base';
import type { Result, RebaseResult, PullResult, CommitGraphResult } from './base';
import { sessionsApi } from './sessions';

// Task Attempts / Workspaces APIs
// Note: frontend uses "attemptsApi" but Rust commands use "workspace" prefix
export const attemptsApi = {
  getChildren: async (attemptId: string): Promise<TaskRelationships> => {
    return tauriInvoke<TaskRelationships>('get_workspace_children', {
      workspaceId: attemptId,
    });
  },

  getAll: async (taskId: string): Promise<Workspace[]> => {
    return tauriInvoke<Workspace[]>('get_workspaces', { taskId });
  },

  /** Get all workspaces across all tasks (newest first) */
  getAllWorkspaces: async (): Promise<Workspace[]> => {
    return tauriInvoke<Workspace[]>('get_workspaces', { taskId: null });
  },

  /** Get total count of workspaces */
  getCount: async (): Promise<number> => {
    return tauriInvoke<number>('get_workspace_count');
  },

  get: async (attemptId: string): Promise<Workspace> => {
    return tauriInvoke<Workspace>('get_workspace', {
      workspaceId: attemptId,
    });
  },

  update: async (
    attemptId: string,
    data: { archived?: boolean; pinned?: boolean; name?: string }
  ): Promise<Workspace> => {
    return tauriInvoke<Workspace>('update_workspace', {
      workspaceId: attemptId,
      payload: data,
    });
  },

  /** Get workspace with latest session */
  getWithSession: async (attemptId: string): Promise<WorkspaceWithSession> => {
    const [workspace, sessions] = await Promise.all([
      attemptsApi.get(attemptId),
      sessionsApi.getByWorkspace(attemptId),
    ]);
    return createWorkspaceWithSession(workspace, sessions[0]);
  },

  create: async (data: CreateTaskAttemptBody): Promise<Workspace> => {
    return tauriInvoke<Workspace>('create_workspace', {
      payload: {
        task_id: data.task_id,
        executor_profile_id: data.executor_profile_id,
        repos: data.repos,
      },
    });
  },

  stop: async (attemptId: string): Promise<void> => {
    return tauriInvoke<void>('stop_workspace_execution', {
      workspaceId: attemptId,
    });
  },

  delete: async (
    attemptId: string,
    deleteBranches?: boolean
  ): Promise<void> => {
    return tauriInvoke<void>('delete_workspace', {
      workspaceId: attemptId,
      deleteBranches: deleteBranches ?? null,
    });
  },

  linkToIssue: async (
    _workspaceId: string,
    _projectId: string,
    _issueId: string
  ): Promise<void> => {
    // TODO: link_workspace not yet implemented in Tauri commands
    throw new Error('linkToIssue not yet implemented in Tauri');
  },

  unlinkFromIssue: async (_workspaceId: string): Promise<void> => {
    // TODO: unlink_workspace not yet implemented in Tauri commands
    throw new Error('unlinkFromIssue not yet implemented in Tauri');
  },

  runAgentSetup: async (
    attemptId: string,
    data: RunAgentSetupRequest
  ): Promise<ExecutionProcess> => {
    return tauriInvoke<ExecutionProcess>('run_agent_setup', {
      workspaceId: attemptId,
      executorProfileId: data.executor_profile_id,
    });
  },

  openEditor: async (
    attemptId: string,
    data: OpenEditorRequest
  ): Promise<OpenEditorResponse> => {
    return tauriInvoke<OpenEditorResponse>('open_workspace_in_editor', {
      workspaceId: attemptId,
      editorType: data.editor_type ?? null,
      filePath: data.file_path ?? null,
    });
  },

  getBranchStatus: async (attemptId: string): Promise<RepoBranchStatus[]> => {
    return tauriInvoke<RepoBranchStatus[]>('get_workspace_branch_status', {
      workspaceId: attemptId,
    });
  },

  getRepos: async (attemptId: string): Promise<RepoWithTargetBranch[]> => {
    return tauriInvoke<RepoWithTargetBranch[]>('get_workspace_repos', {
      workspaceId: attemptId,
    });
  },

  getFirstUserMessage: async (attemptId: string): Promise<string | null> => {
    return tauriInvoke<string | null>('get_first_user_message', {
      workspaceId: attemptId,
    });
  },

  merge: async (
    attemptId: string,
    data: MergeTaskAttemptRequest
  ): Promise<void> => {
    return tauriInvoke<void>('merge_workspace', {
      workspaceId: attemptId,
      repoId: data.repo_id,
    });
  },

  push: async (
    attemptId: string,
    data: PushTaskAttemptRequest
  ): Promise<Result<void, PushError>> => {
    return invokeAsResult<void, PushError>('push_workspace_branch', {
      workspaceId: attemptId,
      repoId: data.repo_id,
      force: null,
    });
  },

  forcePush: async (
    attemptId: string,
    data: PushTaskAttemptRequest
  ): Promise<Result<void, PushError>> => {
    return invokeAsResult<void, PushError>('push_workspace_branch', {
      workspaceId: attemptId,
      repoId: data.repo_id,
      force: true,
    });
  },

  rebase: async (
    attemptId: string,
    data: RebaseTaskAttemptRequest
  ): Promise<RebaseResult> => {
    return tauriInvoke<RebaseResult>('rebase_workspace', {
      workspaceId: attemptId,
      repoId: data.repo_id,
      oldBaseBranch: data.old_base_branch ?? null,
      newBaseBranch: data.new_base_branch ?? null,
    });
  },

  change_target_branch: async (
    attemptId: string,
    data: ChangeTargetBranchRequest
  ): Promise<ChangeTargetBranchResponse> => {
    return tauriInvoke<ChangeTargetBranchResponse>(
      'change_workspace_target_branch',
      {
        workspaceId: attemptId,
        repoId: data.repo_id,
        newTargetBranch: data.new_target_branch,
      }
    );
  },

  renameBranch: async (
    attemptId: string,
    newBranchName: string
  ): Promise<RenameBranchResponse> => {
    return tauriInvoke<RenameBranchResponse>('rename_workspace_branch', {
      workspaceId: attemptId,
      newBranchName,
    });
  },

  rebaseBack: async (
    attemptId: string,
    repoId: string
  ): Promise<RebaseResult> => {
    return tauriInvoke<RebaseResult>('rebase_back_workspace', {
      workspaceId: attemptId,
      repoId,
    });
  },

  abortConflicts: async (
    attemptId: string,
    data: AbortConflictsRequest
  ): Promise<void> => {
    return tauriInvoke<void>('abort_conflicts_workspace', {
      workspaceId: attemptId,
      repoId: data.repo_id,
    });
  },

  continueRebase: async (
    attemptId: string,
    data: ContinueRebaseRequest
  ): Promise<void> => {
    return tauriInvoke<void>('continue_rebase_workspace', {
      workspaceId: attemptId,
      repoId: data.repo_id,
    });
  },

  createPR: async (
    attemptId: string,
    data: CreatePrApiRequest
  ): Promise<Result<string, PrError>> => {
    return invokeAsResult<string, PrError>('create_workspace_pr', {
      workspaceId: attemptId,
      title: data.title,
      body: data.body ?? null,
      targetBranch: data.target_branch ?? null,
      draft: data.draft ?? null,
      repoId: data.repo_id,
      autoGenerateDescription: data.auto_generate_description ?? null,
    });
  },

  startDevServer: async (attemptId: string): Promise<ExecutionProcess[]> => {
    return tauriInvoke<ExecutionProcess[]>('start_workspace_dev_server', {
      workspaceId: attemptId,
    });
  },

  installWebCompanion: async (
    attemptId: string,
    repoId: string
  ): Promise<void> => {
    return tauriInvoke<void>('install_web_companion', {
      workspaceId: attemptId,
      repoId,
    });
  },

  setupGhCli: async (attemptId: string): Promise<ExecutionProcess> => {
    return tauriInvoke<ExecutionProcess>('gh_cli_setup', {
      workspaceId: attemptId,
    });
  },

  runSetupScript: async (
    attemptId: string
  ): Promise<Result<ExecutionProcess, RunScriptError>> => {
    return invokeAsResult<ExecutionProcess, RunScriptError>(
      'run_setup_script',
      { workspaceId: attemptId }
    );
  },

  runCleanupScript: async (
    attemptId: string
  ): Promise<Result<ExecutionProcess, RunScriptError>> => {
    return invokeAsResult<ExecutionProcess, RunScriptError>(
      'run_cleanup_script',
      { workspaceId: attemptId }
    );
  },

  runArchiveScript: async (
    attemptId: string
  ): Promise<Result<ExecutionProcess, RunScriptError>> => {
    return invokeAsResult<ExecutionProcess, RunScriptError>(
      'run_archive_script',
      { workspaceId: attemptId }
    );
  },

  getPrComments: async (
    attemptId: string,
    repoId: string
  ): Promise<PrCommentsResponse> => {
    return tauriInvoke<PrCommentsResponse>('get_workspace_pr_comments', {
      workspaceId: attemptId,
      repoId,
    });
  },

  getCommitHistory: async (workspaceId: string, repoId: string): Promise<{ message: string }[]> => {
    return tauriInvoke<{ message: string }[]>('get_workspace_commit_history', { workspaceId, repoId });
  },

  getCommitGraph: async (workspaceId: string, repoId: string, maxCommits?: number): Promise<CommitGraphResult> => {
    return tauriInvoke<CommitGraphResult>('get_workspace_commit_graph', {
      workspaceId,
      repoId,
      maxCommits: maxCommits ?? 100,
    });
  },

  // ── Git Panel operations ──────────────────────────────────────────

  getGitStatus: async (workspaceId: string, repoId: string): Promise<DetailedGitStatus> => {
    return tauriInvoke<DetailedGitStatus>('get_workspace_git_status', { workspaceId, repoId });
  },

  stageFile: async (workspaceId: string, repoId: string, filePath: string): Promise<void> => {
    return tauriInvoke<void>('stage_workspace_file', { workspaceId, repoId, filePath });
  },

  stageAll: async (workspaceId: string, repoId: string): Promise<void> => {
    return tauriInvoke<void>('stage_workspace_all', { workspaceId, repoId });
  },

  unstageFile: async (workspaceId: string, repoId: string, filePath: string): Promise<void> => {
    return tauriInvoke<void>('unstage_workspace_file', { workspaceId, repoId, filePath });
  },

  revertFile: async (workspaceId: string, repoId: string, filePath: string): Promise<void> => {
    return tauriInvoke<void>('revert_workspace_file', { workspaceId, repoId, filePath });
  },

  revertAll: async (workspaceId: string, repoId: string): Promise<void> => {
    return tauriInvoke<void>('revert_workspace_all', { workspaceId, repoId });
  },

  getFileDiffs: async (workspaceId: string, repoId: string): Promise<GitFileDiffEntry[]> => {
    return tauriInvoke<GitFileDiffEntry[]>('get_workspace_file_diffs', { workspaceId, repoId });
  },

  commitChanges: async (workspaceId: string, repoId: string, message: string): Promise<void> => {
    return tauriInvoke<void>('commit_workspace_changes', { workspaceId, repoId, message });
  },

  getGitLog: async (workspaceId: string, repoId: string): Promise<GitLogStatus> => {
    return tauriInvoke<GitLogStatus>('get_workspace_git_log', { workspaceId, repoId });
  },

  getCommitDetail: async (workspaceId: string, repoId: string, sha: string): Promise<CommitDetail> => {
    return tauriInvoke<CommitDetail>('get_workspace_commit_detail', { workspaceId, repoId, sha });
  },

  getCommitDiffs: async (workspaceId: string, repoId: string, sha: string): Promise<Diff[]> => {
    return tauriInvoke<Diff[]>('get_workspace_commit_diffs', { workspaceId, repoId, sha });
  },

  cherryPick: async (workspaceId: string, repoId: string, sha: string): Promise<void> => {
    return tauriInvoke<void>('git_cherry_pick', { workspaceId, repoId, sha });
  },

  revertCommit: async (workspaceId: string, repoId: string, sha: string): Promise<void> => {
    return tauriInvoke<void>('git_revert_commit', { workspaceId, repoId, sha });
  },

  resetToCommit: async (workspaceId: string, repoId: string, sha: string, mode: ResetMode): Promise<void> => {
    return tauriInvoke<void>('git_reset_to_commit', { workspaceId, repoId, sha, mode });
  },

  createBranchAtCommit: async (workspaceId: string, repoId: string, branchName: string, sha: string): Promise<void> => {
    return tauriInvoke<void>('git_create_branch_at_commit', { workspaceId, repoId, branchName, sha });
  },

  pullBranch: async (workspaceId: string, repoId: string): Promise<PullResult> => {
    return tauriInvoke<PullResult>('pull_workspace_branch', { workspaceId, repoId });
  },

  fetchRemote: async (workspaceId: string, repoId: string): Promise<void> => {
    return tauriInvoke<void>('fetch_workspace', { workspaceId, repoId });
  },

  checkoutBranch: async (workspaceId: string, repoId: string, branchName: string): Promise<void> => {
    return tauriInvoke<void>('checkout_workspace_branch', { workspaceId, repoId, branchName });
  },

  createBranch: async (workspaceId: string, repoId: string, branchName: string, fromRef?: string): Promise<void> => {
    return tauriInvoke<void>('create_workspace_branch', { workspaceId, repoId, branchName, fromRef: fromRef ?? null });
  },

  deleteBranch: async (workspaceId: string, repoId: string, branchName: string): Promise<void> => {
    return tauriInvoke<void>('delete_workspace_branch', { workspaceId, repoId, branchName });
  },

  // ─────────────────────────────────────────────────────────────────

  /** Mark all coding agent turns for a workspace as seen */
  markSeen: async (attemptId: string): Promise<void> => {
    return tauriInvoke<void>('mark_workspace_seen', {
      workspaceId: attemptId,
    });
  },

  /** Create a workspace directly from a pull request */
  createFromPr: async (
    data: CreateWorkspaceFromPrBody
  ): Promise<Result<CreateWorkspaceFromPrResponse, string>> => {
    return invokeAsResult<CreateWorkspaceFromPrResponse, string>(
      'create_workspace_from_pr',
      { payload: data }
    );
  },
};
