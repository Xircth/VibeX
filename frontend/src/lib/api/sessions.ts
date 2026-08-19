import type { ResetProcessRequest, Session, Workspace } from 'shared/types';

import { backendCall } from './base';
import type { SessionStatus, SessionSummary } from './base';

// Sessions API
export const sessionsApi = {
  getByWorkspace: async (workspaceId: string): Promise<Session[]> => {
    return backendCall<Session[]>('get_sessions', { workspaceId });
  },

  getSummariesByWorkspace: async (
    workspaceId: string
  ): Promise<SessionSummary[]> => {
    return backendCall<SessionSummary[]>('get_session_summaries', {
      workspaceId,
    });
  },

  getById: async (sessionId: string): Promise<Session> => {
    return backendCall<Session>('get_session', { sessionId });
  },

  create: async (data: {
    workspace_id: string;
    executor?: string;
    name?: string | null;
    initial_prompt?: string | null;
    task_id?: string | null;
  }): Promise<Session> => {
    return backendCall<Session>('create_session', {
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
    return backendCall<Session>('create_project_root_session', {
      projectId: data.project_id,
      executor: data.executor ?? null,
      name: data.name ?? null,
    });
  },

  createProject: async (data: {
    session_id?: string | null;
    project_id: string;
    workspace_id?: string | null;
    branch?: string | null;
    executor?: string;
    name?: string | null;
    initial_prompt?: string | null;
    create_workspace?: boolean;
    repos?: Array<{ repo_id: string; target_branch: string }>;
  }): Promise<Session> => {
    return backendCall<Session>('create_project_session', {
      payload: {
        session_id: data.session_id ?? null,
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
    return backendCall<Workspace>('ensure_project_workspace', {
      projectId: data.project_id,
      branch: data.branch ?? null,
    });
  },

  rename: async (sessionId: string, name: string | null): Promise<Session> => {
    return backendCall<Session>('rename_session', {
      sessionId,
      name,
    });
  },

  updateStatus: async (
    sessionId: string,
    status: SessionStatus
  ): Promise<Session> => {
    return backendCall<Session>('update_session_status', {
      sessionId,
      status,
    });
  },

  setPinned: async (sessionId: string, pinned: boolean): Promise<Session> => {
    return backendCall<Session>('set_session_pinned', {
      sessionId,
      pinned,
    });
  },

  delete: async (sessionId: string): Promise<void> => {
    return backendCall<void>('delete_session', { sessionId });
  },

  reset: async (
    sessionId: string,
    data: ResetProcessRequest
  ): Promise<void> => {
    return backendCall<void>('reset_session_process', {
      sessionId,
      processId: data.process_id,
      forceWhenDirty: data.force_when_dirty ?? null,
      performGitReset: data.perform_git_reset ?? null,
    });
  },
};
