import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { createElement, StrictMode, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import type { Workspace, WorkspaceWithStatus } from 'shared/types';
import type { SessionSummary } from '@/lib/api';

const mocks = vi.hoisted(() => ({
  getSummariesByWorkspace: vi.fn(),
  translate: vi.fn((key: string) =>
    key === 'kanbanSessions.sessionFallback' ? '新会话' : key
  ),
}));

const workspace: Workspace = {
  id: 'workspace-1',
  project_id: 'project-1',
  task_id: 'task-1',
  parent_workspace_id: null,
  container_ref: null,
  branch: 'main',
  use_worktree: false,
  agent_working_dir: null,
  setup_completed_at: null,
  created_at: '2026-07-27T00:00:00Z',
  updated_at: '2026-07-27T00:00:00Z',
  archived: false,
  pinned: false,
  name: 'Workspace',
};
const workspaceWithStatus: WorkspaceWithStatus = {
  ...workspace,
  is_running: false,
  is_errored: false,
};
const workspaces = [workspace];
const workspacesWithStatus = [workspaceWithStatus];

vi.mock('@/lib/api', () => ({
  sessionsApi: {
    getSummariesByWorkspace: mocks.getSummariesByWorkspace,
  },
}));

vi.mock('./useProjectWorkspacesStream', () => ({
  useProjectWorkspacesStream: () => ({
    workspaces,
    workspacesWithStatus,
    workspacesById: { [workspace.id]: workspace },
    isLoading: false,
    isConnected: true,
    error: null,
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: mocks.translate,
  }),
}));

import {
  buildDefaultSessionName,
  useKanbanProjectSessions,
} from './useKanbanProjectSessions';

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'session-1',
    workspace_id: 'workspace-1',
    task_id: null,
    name: null,
    display_name: '修复会话标题功能',
    status: 'todo',
    executor: 'codex',
    workspace_name: 'Workspace',
    workspace_branch: 'main',
    created_at: '2026-07-27T00:00:00Z',
    updated_at: '2026-07-27T00:00:00Z',
    first_prompt: '修复会话标题功能并保持手动标题',
    is_running: false,
    continuity_mode: 'new_session',
    pinned_at: null,
    ...overrides,
  };
}

describe('buildDefaultSessionName', () => {
  it('uses the first eight characters of the first prompt', () => {
    const t = vi.fn(() => '新会话') as unknown as TFunction<['app', 'common']>;

    expect(buildDefaultSessionName(summary(), t)).toEqual({
      name: '修复会话标题功能',
      source: 'prompt',
      prompt: '修复会话标题功能并保持手动标题',
    });
  });

  it('keeps the backend placeholder in the fallback naming path', () => {
    const t = vi.fn(() => '新会话') as unknown as TFunction<['app', 'common']>;

    expect(
      buildDefaultSessionName(
        summary({
          display_name: '新会话',
          first_prompt: null,
        }),
        t
      )
    ).toEqual({
      name: '新会话1',
      source: 'fallback',
      prompt: null,
    });
  });
});

describe('useKanbanProjectSessions', () => {
  beforeEach(() => {
    mocks.getSummariesByWorkspace.mockReset();
    mocks.getSummariesByWorkspace.mockResolvedValue([summary()]);
  });

  it('keeps derived sessions stable and seeds caches only once across rerenders', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    const setQueryDataSpy = vi.spyOn(queryClient, 'setQueryData');
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(StrictMode, null, children)
      );

    const { result, rerender } = renderHook(
      () => useKanbanProjectSessions('project-1'),
      { wrapper }
    );

    await waitFor(() => expect(result.current.sessions).toHaveLength(1));
    const sessionsAfterLoad = result.current.sessions;
    const sessionCacheWritesAfterLoad = setQueryDataSpy.mock.calls.filter(
      ([queryKey]) => Array.isArray(queryKey) && queryKey[0] === 'session'
    ).length;

    rerender();
    rerender();

    expect(result.current.sessions).toBe(sessionsAfterLoad);
    expect(
      setQueryDataSpy.mock.calls.filter(
        ([queryKey]) => Array.isArray(queryKey) && queryKey[0] === 'session'
      )
    ).toHaveLength(sessionCacheWritesAfterLoad);
    expect(sessionCacheWritesAfterLoad).toBe(1);
  });
});
