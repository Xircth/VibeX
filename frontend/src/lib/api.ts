// Import all necessary types from shared types

import {
  ApprovalStatus,
  Config,
  CreateFollowUpAttempt,
  ResetProcessRequest,
  EditorType,
  CreatePrApiRequest,
  CreateTask,
  CreateAndStartTaskRequest,
  CreateTaskAttemptBody,
  CreateTag,
  DirectoryListResponse,
  DirectoryEntry,
  ExecutionProcess,
  ExecutionProcessRepoState,
  GitBranch,
  Project,
  Repo,
  RepoWithTargetBranch,
  CreateProject,
  CreateProjectRepo,
  UpdateRepo,
  SearchMode,
  SearchResult,
  Task,
  TaskRelationships,
  Tag,
  TagSearchParams,
  TaskWithAttemptStatus,
  UpdateProject,
  UpdateTask,
  UpdateTag,
  UserSystemInfo,
  McpServerQuery,
  UpdateMcpServersBody,
  GetMcpServerResponse,
  ImageResponse,
  GitOperationError,
  ApprovalResponse,
  RebaseTaskAttemptRequest,
  ChangeTargetBranchRequest,
  ChangeTargetBranchResponse,
  RenameBranchResponse,
  CheckEditorAvailabilityResponse,
  AvailabilityInfo,
  BaseCodingAgent,
  ExecutorProfileId,
  RunAgentSetupRequest,
  RunScriptError,
  OpenEditorResponse,
  OpenEditorRequest,
  PrError,
  Scratch,
  ScratchType,
  CreateScratch,
  UpdateScratch,
  PushError,
  QueueStatus,
  PrCommentsResponse,
  MergeTaskAttemptRequest,
  PushTaskAttemptRequest,
  RepoBranchStatus,
  AbortConflictsRequest,
  ContinueRebaseRequest,
  Session,
  Workspace,
  StartReviewRequest,
  OpenPrInfo,
  GitHubIssueInfo,
  GitRemote,
  CreateWorkspaceFromPrBody,
  CreateWorkspaceFromPrResponse,
  DetailedGitStatus,
  GitFileDiffEntry,
  GitLogStatus,
} from 'shared/types';

// Commit graph types (not generated from Rust via ts-rs, defined locally)
// Pull result type (matches Rust PullResult — will be auto-generated after `cargo run --bin generate-types`)
export interface PullResult {
  success: boolean;
  new_commits: number;
  error: string | null;
}

export interface CommitGraphNode {
  hash: string;
  full_hash: string;
  message: string;
  author: string;
  timestamp: number;
  parents: string[];
  refs: string[];
  is_current_branch: boolean;
}

export interface CommitGraphResult {
  nodes: CommitGraphNode[];
  merge_base: string | null;
  current_branch: string;
  target_branch: string;
}

export interface SessionSummary {
  id: string;
  workspace_id: string;
  executor: string | null;
  created_at: string;
  updated_at: string;
  first_prompt: string | null;
  is_running: boolean;
}
import type { WorkspaceWithSession } from '@/types/attempt';
import { createWorkspaceWithSession } from '@/types/attempt';
import { tauriInvoke } from './tauri-api';

// Re-export Result type for consumers that still import it
export type Ok<T> = { success: true; data: T };
export type Err<E> = { success: false; error: E | undefined; message?: string };
export type Result<T, E> = Ok<T> | Err<E>;

// Helper to convert try/catch pattern into Result type for backward compat
async function invokeAsResult<T, E>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<Result<T, E>> {
  try {
    const data = await tauriInvoke<T>(cmd, args);
    return { success: true, data };
  } catch (error) {
    // Tauri errors come as strings or objects
    const errorStr = typeof error === 'string' ? error : JSON.stringify(error);
    let errorData: E | undefined;
    try {
      errorData = typeof error === 'string' ? JSON.parse(error) : (error as E);
    } catch {
      errorData = undefined;
    }
    return { success: false, error: errorData, message: errorStr };
  }
}

// Project Management APIs
export const projectsApi = {
  getAll: async (): Promise<Project[]> => {
    return tauriInvoke<Project[]>('get_projects');
  },

  create: async (data: CreateProject): Promise<Project> => {
    return tauriInvoke<Project>('create_project', { payload: data });
  },

  update: async (id: string, data: UpdateProject): Promise<Project> => {
    return tauriInvoke<Project>('update_project', { id, payload: data });
  },

  delete: async (id: string): Promise<void> => {
    return tauriInvoke<void>('delete_project', { id });
  },

  openEditor: async (
    id: string,
    data: OpenEditorRequest
  ): Promise<OpenEditorResponse> => {
    return tauriInvoke<OpenEditorResponse>('open_project_in_editor', {
      id,
      payload: data,
    });
  },

  searchFiles: async (
    id: string,
    query: string,
    mode?: SearchMode
  ): Promise<SearchResult[]> => {
    return tauriInvoke<SearchResult[]>('search_project_files', {
      id,
      q: query,
      mode: mode ?? null,
    });
  },

  getRepositories: async (projectId: string): Promise<Repo[]> => {
    return tauriInvoke<Repo[]>('get_project_repositories', { id: projectId });
  },

  addRepository: async (
    projectId: string,
    data: CreateProjectRepo
  ): Promise<Repo> => {
    return tauriInvoke<Repo>('add_project_repository', {
      id: projectId,
      payload: data,
    });
  },

  deleteRepository: async (
    projectId: string,
    repoId: string
  ): Promise<void> => {
    return tauriInvoke<void>('delete_project_repository', {
      projectId,
      repoId,
    });
  },
};

// Task Management APIs
export const tasksApi = {
  getById: async (taskId: string): Promise<Task> => {
    return tauriInvoke<Task>('get_task', { taskId });
  },

  create: async (data: CreateTask): Promise<Task> => {
    return tauriInvoke<Task>('create_task', { payload: data });
  },

  createAndStart: async (
    data: CreateAndStartTaskRequest
  ): Promise<TaskWithAttemptStatus> => {
    return tauriInvoke<TaskWithAttemptStatus>('create_task_and_start', {
      payload: data,
    });
  },

  update: async (taskId: string, data: UpdateTask): Promise<Task> => {
    return tauriInvoke<Task>('update_task', { taskId, payload: data });
  },

  delete: async (taskId: string): Promise<void> => {
    return tauriInvoke<void>('delete_task', { taskId });
  },
};

// Sessions API
export const sessionsApi = {
  getByWorkspace: async (workspaceId: string): Promise<Session[]> => {
    return tauriInvoke<Session[]>('get_sessions', { workspaceId });
  },

  getSummariesByWorkspace: async (
    workspaceId: string
  ): Promise<SessionSummary[]> => {
    return tauriInvoke<SessionSummary[]>('get_session_summaries', {
      workspaceId,
    });
  },

  getById: async (sessionId: string): Promise<Session> => {
    return tauriInvoke<Session>('get_session', { sessionId });
  },

  create: async (data: {
    workspace_id: string;
    executor?: string;
  }): Promise<Session> => {
    return tauriInvoke<Session>('create_session', {
      workspaceId: data.workspace_id,
      executor: data.executor ?? null,
    });
  },

  followUp: async (
    sessionId: string,
    data: CreateFollowUpAttempt
  ): Promise<ExecutionProcess> => {
    return tauriInvoke<ExecutionProcess>('follow_up', {
      sessionId,
      prompt: data.prompt,
      executorProfileId: data.executor_profile_id,
      retryProcessId: data.retry_process_id ?? null,
      forceWhenDirty: data.force_when_dirty ?? null,
      performGitReset: data.perform_git_reset ?? null,
    });
  },

  startReview: async (
    sessionId: string,
    data: StartReviewRequest
  ): Promise<ExecutionProcess> => {
    return tauriInvoke<ExecutionProcess>('start_review', {
      sessionId,
      executorProfileId: data.executor_profile_id,
      additionalPrompt: data.additional_prompt ?? null,
      useAllWorkspaceCommits: data.use_all_workspace_commits ?? null,
    });
  },

  reset: async (
    sessionId: string,
    data: ResetProcessRequest
  ): Promise<void> => {
    return tauriInvoke<void>('reset_session_process', {
      sessionId,
      processId: data.process_id,
      forceWhenDirty: data.force_when_dirty ?? null,
      performGitReset: data.perform_git_reset ?? null,
    });
  },
};

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
  ): Promise<Result<void, GitOperationError>> => {
    return invokeAsResult<void, GitOperationError>('rebase_workspace', {
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
  ): Promise<Result<void, GitOperationError>> => {
    return invokeAsResult<void, GitOperationError>('rebase_back_workspace', {
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

// Execution Process APIs
export const executionProcessesApi = {
  getDetails: async (processId: string): Promise<ExecutionProcess> => {
    return tauriInvoke<ExecutionProcess>('get_execution_process', {
      id: processId,
    });
  },

  getRepoStates: async (
    processId: string
  ): Promise<ExecutionProcessRepoState[]> => {
    return tauriInvoke<ExecutionProcessRepoState[]>(
      'get_execution_process_repo_states',
      { id: processId }
    );
  },

  stopExecutionProcess: async (processId: string): Promise<void> => {
    return tauriInvoke<void>('stop_execution_process', { id: processId });
  },
};

// File Tree APIs
export interface FileTreeEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children: FileTreeEntry[] | null;
  git_status: string | null;
}

export interface DirectoryChildrenResponse {
  files: string[];
  directories: string[];
  gitignored_files: string[];
  gitignored_directories: string[];
}

export interface ReadFileResponse {
  content: string;
  truncated: boolean;
}

export interface TextSearchMatch {
  line: number;
  column: number;
  end_column: number;
  preview: string;
}

export interface TextSearchFileResult {
  path: string;
  match_count: number;
  matches: TextSearchMatch[];
}

export interface TextSearchResponse {
  files: TextSearchFileResult[];
  file_count: number;
  total_matches: number;
  truncated: boolean;
}

export interface TextSearchOptions {
  query: string;
  is_regex?: boolean;
  case_sensitive?: boolean;
  whole_word?: boolean;
  include_pattern?: string;
  exclude_pattern?: string;
}

export const fileTreeApi = {
  getTree: async (rootPath: string, depth?: number): Promise<FileTreeEntry[]> => {
    return tauriInvoke<FileTreeEntry[]>('get_file_tree', {
      rootPath,
      depth: depth ?? null,
    });
  },

  readFile: async (path: string): Promise<string> => {
    return tauriInvoke<string>('read_file_content', { path });
  },

  saveFile: async (path: string, content: string): Promise<void> => {
    return tauriInvoke<void>('save_file_content', { path, content });
  },

  deleteFile: async (path: string): Promise<void> => {
    return tauriInvoke<void>('delete_file', { path });
  },

  getFileAtHead: async (filePath: string): Promise<string> => {
    return tauriInvoke<string>('get_file_at_head', { filePath });
  },

  getClaudeSettingsPath: async (): Promise<string> => {
    return tauriInvoke<string>('get_claude_settings_path');
  },

  listDirectoryChildren: async (
    rootPath: string,
    relativePath: string,
  ): Promise<DirectoryChildrenResponse> => {
    return tauriInvoke<DirectoryChildrenResponse>('list_directory_children', {
      rootPath,
      relativePath,
    });
  },

  readFileWithTruncation: async (
    path: string,
    maxBytes?: number,
  ): Promise<ReadFileResponse> => {
    return tauriInvoke<ReadFileResponse>('read_file_with_truncation', {
      path,
      maxBytes: maxBytes ?? null,
    });
  },

  trashItem: async (path: string): Promise<void> => {
    return tauriInvoke<void>('trash_item', { path });
  },

  copyItem: async (path: string): Promise<string> => {
    return tauriInvoke<string>('copy_item', { path });
  },

  createDirectory: async (path: string): Promise<void> => {
    return tauriInvoke<void>('create_directory', { path });
  },

  searchText: async (
    rootPath: string,
    options: TextSearchOptions,
  ): Promise<TextSearchResponse> => {
    return tauriInvoke<TextSearchResponse>('search_workspace_text', {
      rootPath,
      options,
    });
  },
};

export const desktopApi = {
  toggleMainWindowDevtools: async (): Promise<boolean> => {
    return tauriInvoke<boolean>('toggle_main_window_devtools');
  },
  getPreviewProxyUrl: async (url: string): Promise<string> => {
    return tauriInvoke<string>('get_preview_proxy_url', { url });
  },
};

// File System APIs
export const fileSystemApi = {
  list: async (path?: string): Promise<DirectoryListResponse> => {
    return tauriInvoke<DirectoryListResponse>('list_directory', {
      path: path ?? null,
    });
  },

  listGitRepos: async (path?: string): Promise<DirectoryEntry[]> => {
    return tauriInvoke<DirectoryEntry[]>('list_git_repos', {
      path: path ?? null,
    });
  },
};

// Repo APIs
export const repoApi = {
  list: async (): Promise<Repo[]> => {
    return tauriInvoke<Repo[]>('get_repos');
  },

  listRecent: async (): Promise<Repo[]> => {
    return tauriInvoke<Repo[]>('get_recent_repos');
  },

  getById: async (repoId: string): Promise<Repo> => {
    return tauriInvoke<Repo>('get_repo', { repoId });
  },

  update: async (repoId: string, data: UpdateRepo): Promise<Repo> => {
    return tauriInvoke<Repo>('update_repo', { repoId, payload: data });
  },

  register: async (data: {
    path: string;
    display_name?: string;
  }): Promise<Repo> => {
    return tauriInvoke<Repo>('register_repo', {
      path: data.path,
      displayName: data.display_name ?? null,
    });
  },

  getBranches: async (repoId: string): Promise<GitBranch[]> => {
    return tauriInvoke<GitBranch[]>('get_repo_branches', { repoId });
  },

  init: async (data: {
    parent_path: string;
    folder_name: string;
  }): Promise<Repo> => {
    return tauriInvoke<Repo>('init_repo', {
      parentPath: data.parent_path,
      folderName: data.folder_name,
    });
  },

  getBatch: async (ids: string[]): Promise<Repo[]> => {
    return tauriInvoke<Repo[]>('get_repos_batch', { ids });
  },

  openEditor: async (
    repoId: string,
    data: OpenEditorRequest
  ): Promise<OpenEditorResponse> => {
    return tauriInvoke<OpenEditorResponse>('open_repo_in_editor', {
      repoId,
      payload: data,
    });
  },

  searchFiles: async (
    repoId: string,
    query: string,
    mode?: SearchMode
  ): Promise<SearchResult[]> => {
    return tauriInvoke<SearchResult[]>('search_repo', {
      repoId,
      q: query,
      mode: mode ?? null,
    });
  },

  listOpenPrs: async (
    repoId: string,
    remoteName?: string
  ): Promise<Result<OpenPrInfo[], string>> => {
    return invokeAsResult<OpenPrInfo[], string>('list_open_prs', {
      repoId,
      remote: remoteName ?? null,
    });
  },

  listRepoIssues: async (
    repoId: string,
    issueState?: string,
    remoteName?: string
  ): Promise<Result<GitHubIssueInfo[], string>> => {
    return invokeAsResult<GitHubIssueInfo[], string>('list_repo_issues', {
      repoId,
      issueState: issueState ?? null,
      remote: remoteName ?? null,
    });
  },

  listRemotes: async (repoId: string): Promise<GitRemote[]> => {
    return tauriInvoke<GitRemote[]>('get_repo_remotes', { repoId });
  },
};

// Config APIs
export const configApi = {
  getConfig: async (): Promise<UserSystemInfo> => {
    return tauriInvoke<UserSystemInfo>('get_user_system_info');
  },
  saveConfig: async (config: Config): Promise<Config> => {
    return tauriInvoke<Config>('update_config', { newConfig: config });
  },
  checkEditorAvailability: async (
    editorType: EditorType
  ): Promise<CheckEditorAvailabilityResponse> => {
    return tauriInvoke<CheckEditorAvailabilityResponse>(
      'check_editor_availability',
      { editorType }
    );
  },
  checkAgentAvailability: async (
    agent: BaseCodingAgent
  ): Promise<AvailabilityInfo> => {
    return tauriInvoke<AvailabilityInfo>('check_agent_availability', {
      executor: agent,
    });
  },
};

// Claude Settings (~/.claude/settings.json) APIs
export interface ClaudeSettings {
  env: Record<string, string>;
  enabled_plugins: Record<string, boolean>;
}

export const claudeSettingsApi = {
  get: async (): Promise<ClaudeSettings> => {
    return tauriInvoke<ClaudeSettings>('get_claude_settings');
  },
  update: async (settings: ClaudeSettings): Promise<ClaudeSettings> => {
    return tauriInvoke<ClaudeSettings>('update_claude_settings', { settings });
  },
};

// Task Tags APIs (all tags are global)
export const tagsApi = {
  list: async (params?: TagSearchParams): Promise<Tag[]> => {
    return tauriInvoke<Tag[]>('get_tags', {
      search: params?.search ?? null,
    });
  },

  create: async (data: CreateTag): Promise<Tag> => {
    return tauriInvoke<Tag>('create_tag', { payload: data });
  },

  update: async (tagId: string, data: UpdateTag): Promise<Tag> => {
    return tauriInvoke<Tag>('update_tag', { tagId, payload: data });
  },

  delete: async (tagId: string): Promise<void> => {
    return tauriInvoke<void>('delete_tag', { tagId });
  },
};

// MCP Servers APIs
export const mcpServersApi = {
  load: async (query: McpServerQuery): Promise<GetMcpServerResponse> => {
    return tauriInvoke<GetMcpServerResponse>('get_mcp_servers', {
      executor: query.executor,
    });
  },
  save: async (
    query: McpServerQuery,
    data: UpdateMcpServersBody
  ): Promise<void> => {
    await tauriInvoke<string>('update_mcp_servers', {
      executor: query.executor,
      servers: data.servers,
    });
  },
};

// Profiles API
export const profilesApi = {
  load: async (): Promise<{ content: string; path: string }> => {
    return tauriInvoke<{ content: string; path: string }>('get_profiles');
  },
  save: async (content: string): Promise<string> => {
    return tauriInvoke<string>('update_profiles', { body: content });
  },
};

// Images API
// TODO: Image upload functions need special handling for Tauri (no FormData support).
// File reading + base64 encoding via Tauri fs API will be implemented in a follow-up task.
export const imagesApi = {
  upload: async (_file: File): Promise<ImageResponse> => {
    // TODO: Implement via Tauri fs API + base64 invoke
    throw new Error('Image upload not yet implemented for Tauri');
  },

  uploadForTask: async (
    _taskId: string,
    _file: File
  ): Promise<ImageResponse> => {
    // TODO: Implement via Tauri fs API + base64 invoke
    throw new Error('Image upload not yet implemented for Tauri');
  },

  /**
   * Upload an image for a task attempt and immediately copy it to the container.
   * Returns the image with a file_path that can be used in markdown.
   */
  uploadForAttempt: async (
    _attemptId: string,
    _file: File
  ): Promise<ImageResponse> => {
    // TODO: Implement via Tauri fs API + base64 invoke
    throw new Error('Image upload not yet implemented for Tauri');
  },

  delete: async (_imageId: string): Promise<void> => {
    // TODO: Implement image deletion via Tauri command
    throw new Error('Image delete not yet implemented for Tauri');
  },

  getTaskImages: async (_taskId: string): Promise<ImageResponse[]> => {
    // TODO: Implement via Tauri command
    throw new Error('getTaskImages not yet implemented for Tauri');
  },

  getImageUrl: (_imageId: string): string => {
    // TODO: In Tauri, images need to be served differently (e.g., asset protocol)
    return '';
  },
};

// Approval API
export const approvalsApi = {
  respond: async (
    approvalId: string,
    payload: ApprovalResponse
  ): Promise<ApprovalStatus> => {
    return tauriInvoke<ApprovalStatus>('respond_to_approval', {
      approvalId,
      response: payload,
    });
  },
};

// Scratch API
// TODO: Scratch commands not yet implemented in Tauri backend
export const scratchApi = {
  create: async (
    _scratchType: ScratchType,
    _id: string,
    _data: CreateScratch
  ): Promise<Scratch> => {
    throw new Error('Scratch API not yet implemented for Tauri');
  },

  get: async (_scratchType: ScratchType, _id: string): Promise<Scratch> => {
    throw new Error('Scratch API not yet implemented for Tauri');
  },

  update: async (
    _scratchType: ScratchType,
    _id: string,
    _data: UpdateScratch
  ): Promise<void> => {
    throw new Error('Scratch API not yet implemented for Tauri');
  },

  delete: async (_scratchType: ScratchType, _id: string): Promise<void> => {
    throw new Error('Scratch API not yet implemented for Tauri');
  },
};

// Queue API for session follow-up messages
export const queueApi = {
  /**
   * Queue a follow-up message to be executed when current execution finishes
   */
  queue: async (
    sessionId: string,
    data: { message: string; executor_profile_id: ExecutorProfileId }
  ): Promise<QueueStatus> => {
    return tauriInvoke<QueueStatus>('queue_message', {
      sessionId,
      message: data.message,
      executorProfileId: data.executor_profile_id,
    });
  },

  /**
   * Cancel a queued follow-up message
   */
  cancel: async (sessionId: string): Promise<QueueStatus> => {
    return tauriInvoke<QueueStatus>('cancel_queued_message', { sessionId });
  },

  /**
   * Get the current queue status for a session
   */
  getStatus: async (sessionId: string): Promise<QueueStatus> => {
    return tauriInvoke<QueueStatus>('get_queue_status', { sessionId });
  },
};

// Search API (multi-repo file search)
// Note: In Tauri, search_project_files handles project-level search.
// For multi-repo search, we invoke search per repo and merge results.
export const searchApi = {
  searchFiles: async (
    repoIds: string[],
    query: string,
    mode?: SearchMode
  ): Promise<SearchResult[]> => {
    // Search each repo in parallel and merge results
    const results = await Promise.all(
      repoIds.map((repoId) =>
        tauriInvoke<SearchResult[]>('search_repo', {
          repoId,
          q: query,
          mode: mode ?? null,
        })
      )
    );
    return results.flat();
  },
};
