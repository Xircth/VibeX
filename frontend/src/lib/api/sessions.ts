import type {
  CreateFollowUpAttempt,
  ResetProcessRequest,
  ExecutionProcess,
  Session,
  StartReviewRequest,
  Workspace,
} from 'shared/types';

import { tauriInvoke } from './base';
import type { SessionStatus, SessionSummary } from './base';

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
    name?: string | null;
    initial_prompt?: string | null;
    task_id?: string | null;
  }): Promise<Session> => {
    return tauriInvoke<Session>('create_session', {
      workspaceId: data.workspace_id,
      executor: data.executor ?? null,
      name: data.name ?? null,
      initialPrompt: data.initial_prompt ?? null,
      taskId: data.task_id ?? null,
    });
  },

  createProjectRoot: async (data: {
    project_id: string;
    executor?: string;
    name?: string | null;
  }): Promise<Session> => {
    return tauriInvoke<Session>('create_project_root_session', {
      projectId: data.project_id,
      executor: data.executor ?? null,
      name: data.name ?? null,
    });
  },

  createProject: async (data: {
    project_id: string;
    workspace_id?: string | null;
    branch?: string | null;
    executor?: string;
    name?: string | null;
    initial_prompt?: string | null;
    create_workspace?: boolean;
    repos?: Array<{ repo_id: string; target_branch: string }>;
  }): Promise<Session> => {
    return tauriInvoke<Session>('create_project_session', {
      payload: {
        project_id: data.project_id,
        workspace_id: data.workspace_id ?? null,
        branch: data.branch ?? null,
        executor: data.executor ?? null,
        name: data.name ?? null,
        initial_prompt: data.initial_prompt ?? null,
        create_workspace: data.create_workspace ?? null,
        repos: data.repos ?? null,
      },
    });
  },

  ensureProjectWorkspace: async (data: {
    project_id: string;
    branch?: string | null;
  }): Promise<Workspace> => {
    return tauriInvoke<Workspace>('ensure_project_workspace', {
      projectId: data.project_id,
      branch: data.branch ?? null,
    });
  },

  rename: async (sessionId: string, name: string | null): Promise<Session> => {
    return tauriInvoke<Session>('rename_session', {
      sessionId,
      name,
    });
  },

  updateStatus: async (
    sessionId: string,
    status: SessionStatus
  ): Promise<Session> => {
    return tauriInvoke<Session>('update_session_status', {
      sessionId,
      status,
    });
  },

  delete: async (sessionId: string): Promise<void> => {
    return tauriInvoke<void>('delete_session', { sessionId });
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
