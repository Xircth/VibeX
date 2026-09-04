import type {
  CreatePrApiRequest,
  CreateTaskAttemptBody,
  ExecutionProcess,
  RepoWithTargetBranch,
  OpenEditorRequest,
  OpenEditorResponse,
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
  StashEntry,
} from 'shared/types';

import type {
  ConflictFileDetail,
  WriteConflictResolutionResult,
} from 'shared/types';
import type { WorkspaceWithSession } from '@/types/attempt';
import { createWorkspaceWithSession } from '@/types/attempt';
import { backendCall, invokeAsResult } from './base';
import type {
  Result,
  RebaseResult,
  PullResult,
  CommitGraphResult,
} from './base';
import { sessionsApi } from './sessions';
import type {
  RedlineDocument,
  TauriInspectorStatus,
} from '@/features/tauri-inspector/tauriInspector';

// Task Attempts / Workspaces APIs
// Note: frontend uses "attemptsApi" but Rust commands use "workspace" prefix
export const attemptsApi = {
  getTauriInspectorStatus: async (
    attemptId: string
  ): Promise<TauriInspectorStatus> => {
    return backendCall<TauriInspectorStatus>('get_tauri_inspector_status', {
      workspaceId: attemptId,
    });
  },

  installTauriInspector: async (
    attemptId: string
  ): Promise<TauriInspectorStatus> => {
    return backendCall<TauriInspectorStatus>('install_tauri_inspector', {
      workspaceId: attemptId,
    });
  },

  controlTauriInspector: async (
    attemptId: string,
    action: 'activate' | 'deactivate'
  ): Promise<void> => {
    return backendCall<void>('control_tauri_inspector', {
      workspaceId: attemptId,
      action,
    });
  },

  takeTauriInspectorCapture: async (
    attemptId: string
  ): Promise<RedlineDocument | null> => {
    return backendCall<RedlineDocument | null>('take_tauri_inspector_capture', {
      workspaceId: attemptId,
    });
  },

  getChildren: async (attemptId: string): Promise<TaskRelationships> => {
    return backendCall<TaskRelationships>('get_workspace_children', {
      workspaceId: attemptId,
    });
  },

  getAll: async (taskId: string): Promise<Workspace[]> => {
    return backendCall<Workspace[]>('get_workspaces', { taskId });
  },

  /** Get all workspaces across all tasks (newest first) */
  getAllWorkspaces: async (): Promise<Workspace[]> => {
    return backendCall<Workspace[]>('get_workspaces', { taskId: null });
  },

  /** Get all workspaces for a project (also syncs local worktrees). */
  getProjectWorkspaces: async (projectId: string): Promise<Workspace[]> => {
    return backendCall<Workspace[]>('get_project_workspaces', { projectId });
  },

  /** Get total count of workspaces */
  getCount: async (): Promise<number> => {
    return backendCall<number>('get_workspace_count');
  },

  get: async (attemptId: string): Promise<Workspace> => {
    return backendCall<Workspace>('get_workspace', {
      workspaceId: attemptId,
    });
  },

  update: async (
    attemptId: string,
    data: { archived?: boolean; pinned?: boolean; name?: string }
  ): Promise<Workspace> => {
    return backendCall<Workspace>('update_workspace', {
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
    return backendCall<Workspace>('create_workspace', {
      payload: {
        task_id: data.task_id,
        executor_profile_id: data.executor_profile_id,
        repos: data.repos,
      },
    });
  },

  stop: async (attemptId: string): Promise<void> => {
    return backendCall<void>('stop_workspace_execution', {
      workspaceId: attemptId,
    });
  },

  delete: async (
    attemptId: string,
    deleteBranches?: boolean
  ): Promise<void> => {
    return backendCall<void>('delete_workspace', {
      workspaceId: attemptId,
      deleteBranches: deleteBranches ?? null,
    });
  },

  openEditor: async (
    attemptId: string,
    data: OpenEditorRequest
  ): Promise<OpenEditorResponse> => {
    return backendCall<OpenEditorResponse>('open_workspace_in_editor', {
      workspaceId: attemptId,
      editorType: data.editor_type ?? null,
      filePath: data.file_path ?? null,
    });
  },

  getBranchStatus: async (attemptId: string): Promise<RepoBranchStatus[]> => {
    return backendCall<RepoBranchStatus[]>('get_workspace_branch_status', {
      workspaceId: attemptId,
    });
  },

  getRepos: async (attemptId: string): Promise<RepoWithTargetBranch[]> => {
    return backendCall<RepoWithTargetBranch[]>('get_workspace_repos', {
      workspaceId: attemptId,
    });
  },

  getFirstUserMessage: async (attemptId: string): Promise<string | null> => {
    return backendCall<string | null>('get_first_user_message', {
      workspaceId: attemptId,
    });
  },

  merge: async (
    attemptId: string,
    data: MergeTaskAttemptRequest
  ): Promise<void> => {
    return backendCall<void>('merge_workspace', {
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
    return backendCall<RebaseResult>('rebase_workspace', {
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
    return backendCall<ChangeTargetBranchResponse>(
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
    return backendCall<RenameBranchResponse>('rename_workspace_branch', {
      workspaceId: attemptId,
      newBranchName,
    });
  },

  rebaseBack: async (
    attemptId: string,
    repoId: string
  ): Promise<RebaseResult> => {
    return backendCall<RebaseResult>('rebase_back_workspace', {
      workspaceId: attemptId,
      repoId,
    });
  },

  abortConflicts: async (
    attemptId: string,
    data: AbortConflictsRequest
  ): Promise<void> => {
    return backendCall<void>('abort_conflicts_workspace', {
      workspaceId: attemptId,
      repoId: data.repo_id,
    });
  },

  continueRebase: async (
    attemptId: string,
    data: ContinueRebaseRequest
  ): Promise<void> => {
    return backendCall<void>('continue_conflicts_workspace', {
      workspaceId: attemptId,
      repoId: data.repo_id,
    });
  },

  continueConflicts: async (
    workspaceId: string,
    repoId: string
  ): Promise<void> => {
    return backendCall<void>('continue_conflicts_workspace', {
      workspaceId,
      repoId,
    });
  },

  getConflictFile: async (
    workspaceId: string,
    repoId: string,
    filePath: string
  ): Promise<ConflictFileDetail> => {
    return backendCall<ConflictFileDetail>('get_workspace_conflict_file', {
      workspaceId,
      repoId,
      filePath,
    });
  },

  writeConflictResolution: async (
    workspaceId: string,
    repoId: string,
    filePath: string,
    content: string
  ): Promise<WriteConflictResolutionResult> => {
    return backendCall<WriteConflictResolutionResult>(
      'write_workspace_conflict_resolution',
      { workspaceId, repoId, filePath, content }
    );
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
    return backendCall<ExecutionProcess[]>('start_workspace_dev_server', {
      workspaceId: attemptId,
    });
  },

  setupGhCli: async (attemptId: string): Promise<ExecutionProcess> => {
    return backendCall<ExecutionProcess>('gh_cli_setup', {
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
    return backendCall<PrCommentsResponse>('get_workspace_pr_comments', {
      workspaceId: attemptId,
      repoId,
    });
  },

  getCommitHistory: async (
    workspaceId: string,
    repoId: string
  ): Promise<{ message: string }[]> => {
    return backendCall<{ message: string }[]>('get_workspace_commit_history', {
      workspaceId,
      repoId,
    });
  },

  getCommitGraph: async (
    workspaceId: string,
    repoId: string,
    maxCommits?: number
  ): Promise<CommitGraphResult> => {
    return backendCall<CommitGraphResult>('get_workspace_commit_graph', {
      workspaceId,
      repoId,
      maxCommits: maxCommits ?? 100,
    });
  },

  // ── Git Panel operations ──────────────────────────────────────────

  getGitStatus: async (
    workspaceId: string,
    repoId: string
  ): Promise<DetailedGitStatus> => {
    return backendCall<DetailedGitStatus>('get_workspace_git_status', {
      workspaceId,
      repoId,
    });
  },

  stageFile: async (
    workspaceId: string,
    repoId: string,
    filePath: string
  ): Promise<void> => {
    return backendCall<void>('stage_workspace_file', {
      workspaceId,
      repoId,
      filePath,
    });
  },

  stageAll: async (workspaceId: string, repoId: string): Promise<void> => {
    return backendCall<void>('stage_workspace_all', { workspaceId, repoId });
  },

  unstageFile: async (
    workspaceId: string,
    repoId: string,
    filePath: string
  ): Promise<void> => {
    return backendCall<void>('unstage_workspace_file', {
      workspaceId,
      repoId,
      filePath,
    });
  },

  revertFile: async (
    workspaceId: string,
    repoId: string,
    filePath: string
  ): Promise<void> => {
    return backendCall<void>('revert_workspace_file', {
      workspaceId,
      repoId,
      filePath,
    });
  },

  revertAll: async (workspaceId: string, repoId: string): Promise<void> => {
    return backendCall<void>('revert_workspace_all', { workspaceId, repoId });
  },

  getFileDiffs: async (
    workspaceId: string,
    repoId: string
  ): Promise<GitFileDiffEntry[]> => {
    return backendCall<GitFileDiffEntry[]>('get_workspace_file_diffs', {
      workspaceId,
      repoId,
    });
  },

  commitChanges: async (
    workspaceId: string,
    repoId: string,
    message: string
  ): Promise<void> => {
    return backendCall<void>('commit_workspace_changes', {
      workspaceId,
      repoId,
      message,
    });
  },

  getGitLog: async (
    workspaceId: string,
    repoId: string
  ): Promise<GitLogStatus> => {
    return backendCall<GitLogStatus>('get_workspace_git_log', {
      workspaceId,
      repoId,
    });
  },

  getCommitDetail: async (
    workspaceId: string,
    repoId: string,
    sha: string
  ): Promise<CommitDetail> => {
    return backendCall<CommitDetail>('get_workspace_commit_detail', {
      workspaceId,
      repoId,
      sha,
    });
  },

  getCommitDiffs: async (
    workspaceId: string,
    repoId: string,
    sha: string
  ): Promise<Diff[]> => {
    return backendCall<Diff[]>('get_workspace_commit_diffs', {
      workspaceId,
      repoId,
      sha,
    });
  },

  cherryPick: async (
    workspaceId: string,
    repoId: string,
    sha: string
  ): Promise<void> => {
    return backendCall<void>('git_cherry_pick', { workspaceId, repoId, sha });
  },

  stash: async (
    workspaceId: string,
    repoId: string,
    message: string | null,
    includeUntracked: boolean
  ): Promise<boolean> => {
    return backendCall<boolean>('stash_workspace', {
      workspaceId,
      repoId,
      message,
      includeUntracked,
    });
  },

  listStashes: async (
    workspaceId: string,
    repoId: string
  ): Promise<StashEntry[]> => {
    return backendCall<StashEntry[]>('list_workspace_stashes', {
      workspaceId,
      repoId,
    });
  },

  applyStash: async (
    workspaceId: string,
    repoId: string,
    index: number
  ): Promise<void> => {
    return backendCall<void>('apply_workspace_stash', {
      workspaceId,
      repoId,
      index,
    });
  },

  popStash: async (
    workspaceId: string,
    repoId: string,
    index: number
  ): Promise<void> => {
    return backendCall<void>('pop_workspace_stash', {
      workspaceId,
      repoId,
      index,
    });
  },

  dropStash: async (
    workspaceId: string,
    repoId: string,
    index: number
  ): Promise<void> => {
    return backendCall<void>('drop_workspace_stash', {
      workspaceId,
      repoId,
      index,
    });
  },

  revertCommit: async (
    workspaceId: string,
    repoId: string,
    sha: string
  ): Promise<void> => {
    return backendCall<void>('git_revert_commit', { workspaceId, repoId, sha });
  },

  resetToCommit: async (
    workspaceId: string,
    repoId: string,
    sha: string,
    mode: ResetMode
  ): Promise<void> => {
    return backendCall<void>('git_reset_to_commit', {
      workspaceId,
      repoId,
      sha,
      mode,
    });
  },

  createBranchAtCommit: async (
    workspaceId: string,
    repoId: string,
    branchName: string,
    sha: string
  ): Promise<void> => {
    return backendCall<void>('git_create_branch_at_commit', {
      workspaceId,
      repoId,
      branchName,
      sha,
    });
  },

  pullBranch: async (
    workspaceId: string,
    repoId: string
  ): Promise<PullResult> => {
    return backendCall<PullResult>('pull_workspace_branch', {
      workspaceId,
      repoId,
    });
  },

  fetchRemote: async (workspaceId: string, repoId: string): Promise<void> => {
    return backendCall<void>('fetch_workspace', { workspaceId, repoId });
  },

  checkoutBranch: async (
    workspaceId: string,
    repoId: string,
    branchName: string
  ): Promise<void> => {
    return backendCall<void>('checkout_workspace_branch', {
      workspaceId,
      repoId,
      branchName,
    });
  },

  createBranch: async (
    workspaceId: string,
    repoId: string,
    branchName: string,
    fromRef?: string
  ): Promise<void> => {
    return backendCall<void>('create_workspace_branch', {
      workspaceId,
      repoId,
      branchName,
      fromRef: fromRef ?? null,
    });
  },

  deleteBranch: async (
    workspaceId: string,
    repoId: string,
    branchName: string
  ): Promise<void> => {
    return backendCall<void>('delete_workspace_branch', {
      workspaceId,
      repoId,
      branchName,
    });
  },

  // ─────────────────────────────────────────────────────────────────

  /** Mark all coding agent turns for a workspace as seen */
  markSeen: async (attemptId: string): Promise<void> => {
    return backendCall<void>('mark_workspace_seen', {
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
