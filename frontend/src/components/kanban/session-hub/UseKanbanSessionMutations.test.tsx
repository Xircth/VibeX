import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AgentKind, ScratchType, type ExecutorProfileId } from 'shared/types';
import type { WorkspaceBranchOption } from '@/lib/workspaceBranchOptions';
import { useKanbanSessionMutations } from './useKanbanSessionMutations';

const { sessionsCreateProjectMock, sessionsRenameMock, scratchUpdateMock } =
  vi.hoisted(() => ({
    sessionsCreateProjectMock: vi.fn(),
    sessionsRenameMock: vi.fn(),
    scratchUpdateMock: vi.fn(),
  }));

vi.mock('@/lib/api', () => ({
  sessionsApi: {
    createProject: sessionsCreateProjectMock,
    rename: sessionsRenameMock,
  },
  scratchApi: {
    update: scratchUpdateMock,
  },
}));

function executorProfile(executor: AgentKind): ExecutorProfileId {
  return { executor } as ExecutorProfileId;
}

function workspaceOption(
  overrides: Partial<WorkspaceBranchOption>
): WorkspaceBranchOption {
  return {
    value: 'workspace:existing',
    branch: 'main',
    workspace: null,
    existingWorkspaceId: 'workspace-1',
    directWorkspaceId: 'workspace-1',
    useWorktree: true,
    isCurrentProjectBranch: false,
    ...overrides,
  };
}

describe('useKanbanSessionMutations', () => {
  it('runs create and rename side effects behind the session mutation hook', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const placeCreatedSession = vi.fn();
    const addPendingCreatedSession = vi.fn();
    const clearCreateSessionName = vi.fn();
    const closeCreatePopover = vi.fn();
    const getWorkspaceRepoInputs = vi.fn(() => [
      { repo_id: 'repo-1', target_branch: 'feature/new' },
    ]);
    const createdSession = {
      id: 'session-1',
      workspace_id: 'workspace-1',
    };
    sessionsCreateProjectMock.mockResolvedValue(createdSession);
    sessionsRenameMock.mockResolvedValue({
      id: 'session-1',
      workspace_id: 'workspace-1',
    });

    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () =>
        useKanbanSessionMutations({
          projectId: 'project-1',
          primaryRepoId: 'repo-1',
          workspaceBranchOptions: [
            workspaceOption({ value: 'workspace:existing' }),
          ],
          getWorkspaceRepoInputs,
          placeCreatedSession,
          addPendingCreatedSession,
          clearCreateSessionName,
          closeCreatePopover,
        }),
      { wrapper }
    );

    await act(async () => {
      await result.current.createSessionMutation.mutateAsync({
        workspaceValue: 'workspace:existing',
        sessionName: '  Ship fix  ',
        executorProfile: executorProfile('codex' as const),
        mode: 'existing_workspace',
        sessionControls: {
          preparedSessionId: 'prepared-session-1',
        },
      });
    });

    expect(sessionsCreateProjectMock).toHaveBeenCalledWith({
      session_id: 'prepared-session-1',
      project_id: 'project-1',
      workspace_id: 'workspace-1',
      branch: null,
      executor: 'codex' as const,
      name: 'Ship fix',
      create_workspace: false,
      repos: undefined,
    });
    expect(scratchUpdateMock).toHaveBeenCalledWith(
      ScratchType.DRAFT_FOLLOW_UP,
      'session-1',
      {
        payload: {
          type: 'DRAFT_FOLLOW_UP',
          data: {
            message: '',
            images: [],
            executor_config: executorProfile('codex' as const),
            queued: false,
            config_overrides: {},
          },
        },
      }
    );
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['kanbanProjectWorkspaces', 'project-1'],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['projectWorktrees', 'project-1'],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['repoBranches', 'repo-1'],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['workspaceSessions', 'workspace-1'],
    });
    expect(placeCreatedSession).toHaveBeenCalledWith({
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
    });
    expect(addPendingCreatedSession).toHaveBeenCalledWith('session-1');
    expect(clearCreateSessionName).toHaveBeenCalledTimes(1);
    expect(closeCreatePopover).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.renameSessionMutation.mutateAsync({
        sessionId: 'session-1',
        name: 'Renamed',
        workspaceId: 'workspace-1',
      });
    });

    expect(sessionsRenameMock).toHaveBeenCalledWith('session-1', 'Renamed');
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['workspaceSessions', 'workspace-1'],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['session', 'session-1'],
    });
  });
});
