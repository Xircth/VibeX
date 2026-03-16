import type {
  GitBranch,
  Repo,
  UpdateRepo,
  SearchMode,
  SearchResult,
  OpenEditorRequest,
  OpenEditorResponse,
  OpenPrInfo,
  GitHubIssueInfo,
  GitRemote,
  DetailedGitStatus,
  GitFileDiffEntry,
  GitLogStatus,
  CommitDetail,
  Diff,
} from 'shared/types';

import { tauriInvoke, invokeAsResult } from './base';
import type { Result, PullResult } from './base';

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

  // ─── Repo-level Git operations ─────────────────────────────────────────────

  getGitStatus: async (repoId: string): Promise<DetailedGitStatus> => {
    return tauriInvoke<DetailedGitStatus>('get_repo_git_status', { repoId });
  },

  getFileDiffs: async (repoId: string): Promise<GitFileDiffEntry[]> => {
    return tauriInvoke<GitFileDiffEntry[]>('get_repo_file_diffs', { repoId });
  },

  stageFile: async (repoId: string, filePath: string): Promise<void> => {
    return tauriInvoke<void>('stage_repo_file', { repoId, filePath });
  },

  unstageFile: async (repoId: string, filePath: string): Promise<void> => {
    return tauriInvoke<void>('unstage_repo_file', { repoId, filePath });
  },

  revertFile: async (repoId: string, filePath: string): Promise<void> => {
    return tauriInvoke<void>('revert_repo_file', { repoId, filePath });
  },

  stageAll: async (repoId: string): Promise<void> => {
    return tauriInvoke<void>('stage_repo_all', { repoId });
  },

  revertAll: async (repoId: string): Promise<void> => {
    return tauriInvoke<void>('revert_repo_all', { repoId });
  },

  commitChanges: async (repoId: string, message: string): Promise<void> => {
    return tauriInvoke<void>('commit_repo_changes', { repoId, message });
  },

  push: async (repoId: string): Promise<void> => {
    return tauriInvoke<void>('push_repo', { repoId });
  },

  pull: async (repoId: string): Promise<PullResult> => {
    return tauriInvoke<PullResult>('pull_repo', { repoId });
  },

  fetch: async (repoId: string): Promise<void> => {
    return tauriInvoke<void>('fetch_repo', { repoId });
  },

  getGitLog: async (repoId: string): Promise<GitLogStatus> => {
    return tauriInvoke<GitLogStatus>('get_repo_git_log', { repoId });
  },

  getCommitDetail: async (repoId: string, sha: string): Promise<CommitDetail> => {
    return tauriInvoke<CommitDetail>('get_repo_commit_detail', { repoId, sha });
  },

  getCommitDiffs: async (repoId: string, sha: string): Promise<Diff[]> => {
    return tauriInvoke<Diff[]>('get_repo_commit_diffs', { repoId, sha });
  },

  checkoutBranch: async (repoId: string, branchName: string): Promise<void> => {
    return tauriInvoke<void>('checkout_repo_branch', { repoId, branchName });
  },

  createBranch: async (repoId: string, branchName: string, fromRef?: string): Promise<void> => {
    return tauriInvoke<void>('create_repo_branch', { repoId, branchName, fromRef: fromRef ?? null });
  },

  deleteBranch: async (repoId: string, branchName: string): Promise<void> => {
    return tauriInvoke<void>('delete_repo_branch', { repoId, branchName });
  },
};
