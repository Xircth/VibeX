import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { forwardRef, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { Session, Workspace } from 'shared/types';
import {
  KanbanSessionConversationPlacementProvider,
  KanbanSessionConversationView,
} from './KanbanSessionConversationView';

const { attemptsGetMock, sessionsGetByIdMock, useWorkspaceSessionsMock } =
  vi.hoisted(() => ({
    attemptsGetMock: vi.fn(() => new Promise<Workspace>(() => {})),
    sessionsGetByIdMock: vi.fn(() => new Promise<Session>(() => {})),
    useWorkspaceSessionsMock: vi.fn(() => ({
      sessions: [] as Array<Record<string, unknown>>,
      selectedSession: undefined as Session | undefined,
      selectedSessionId: undefined as string | undefined,
      selectSession: vi.fn(),
      selectLatestSession: vi.fn(),
      isLoading: false,
      isNewSessionMode: false,
      isPendingNewSessionMode: false,
      requestNewSession: vi.fn(),
      confirmNewSession: vi.fn(),
      cancelNewSession: vi.fn(),
      startNewSession: vi.fn(),
    })),
  }));

vi.mock('@/contexts/ProjectContext', () => ({
  useProject: () => ({ projectId: 'project-1' }),
}));

vi.mock('@/hooks/useWorkspaceSessions', () => ({
  useWorkspaceSessions: useWorkspaceSessionsMock,
  resolveActiveSession: (
    session: Session | undefined,
    sessionState: {
      isNewSessionMode?: boolean;
      selectedSession?: Session | undefined;
      selectedSessionId?: string | undefined;
    }
  ) => {
    if (sessionState.isNewSessionMode) {
      return undefined;
    }

    if (!sessionState.selectedSessionId) {
      return session;
    }

    if (sessionState.selectedSession?.id === sessionState.selectedSessionId) {
      return sessionState.selectedSession;
    }

    if (session?.id === sessionState.selectedSessionId) {
      return session;
    }

    return session;
  },
}));

vi.mock('@/components/logs/VirtualizedList', () => ({
  default: forwardRef(function VirtualizedListMock(
    {
      attempt,
    }: {
      attempt: { id: string; session?: { id?: string } | undefined };
    },
    _ref
  ) {
    return (
      <div data-testid="virtualized-list">
        {attempt.id}:{attempt.session?.id ?? 'none'}
      </div>
    );
  }),
}));

vi.mock('@/components/tasks/TaskFollowUpSection', () => ({
  TaskFollowUpSection: () => <div data-testid="follow-up-section" />,
}));

vi.mock('@/contexts/EntriesContext', () => ({
  EntriesProvider: ({
    children,
    runtimeKey,
  }: {
    children: ReactNode;
    runtimeKey?: string;
  }) => (
    <div data-testid="entries-provider" data-runtime-key={runtimeKey}>
      {children}
    </div>
  ),
}));

vi.mock('@/contexts/ExecutionProcessesContext', () => ({
  ExecutionProcessesProvider: ({ children }: { children: ReactNode }) =>
    children,
}));

vi.mock('@/contexts/RetryUiContext', () => ({
  RetryUiProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('@/lib/api', () => ({
  attemptsApi: {
    get: attemptsGetMock,
  },
  sessionsApi: {
    getById: sessionsGetByIdMock,
  },
}));

function createWorkspace(id: string): Workspace {
  return {
    id,
    project_id: 'project-1',
    task_id: 'task-1',
    parent_workspace_id: null,
    container_ref: null,
    branch: 'feature/test',
    use_worktree: true,
    agent_working_dir: null,
    setup_completed_at: null,
    created_at: '2026-03-24T00:00:00.000Z',
    updated_at: '2026-03-24T00:00:00.000Z',
    archived: false,
    pinned: false,
    name: 'Workspace One',
  };
}

function createSession(id: string, workspaceId: string): Session {
  return {
    id,
    workspace_id: workspaceId,
    task_id: 'task-1',
    name: 'Session One',
    initial_prompt: null,
    status: 'todo',
    executor: null,
    created_at: '2026-03-24T00:00:00.000Z',
    updated_at: '2026-03-24T00:00:00.000Z',
  };
}

describe('KanbanSessionConversationView', () => {
  it('shows a standalone new-session button when a workspace has no existing sessions', () => {
    const startNewSession = vi.fn();
    const onCreateSessionRequested = vi.fn();
    useWorkspaceSessionsMock.mockReturnValue({
      sessions: [],
      selectedSession: undefined,
      selectedSessionId: undefined,
      selectSession: vi.fn(),
      selectLatestSession: vi.fn(),
      isLoading: false,
      isNewSessionMode: false,
      isPendingNewSessionMode: false,
      requestNewSession: vi.fn(),
      confirmNewSession: vi.fn(),
      cancelNewSession: vi.fn(),
      startNewSession,
    });

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    queryClient.setQueryData(['taskAttempt', 'workspace-empty'], {
      ...createWorkspace('workspace-empty'),
      task_id: null,
    });

    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <KanbanSessionConversationView
            workspaceId="workspace-empty"
            interactive={true}
            showSessionSelector={true}
            onCreateSessionRequested={onCreateSessionRequested}
          />
        </QueryClientProvider>
      </MemoryRouter>
    );

    const button = screen.getByRole('button', { name: '新建会话' });
    expect(screen.queryByTestId('virtualized-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('follow-up-section')).not.toBeInTheDocument();

    fireEvent.click(button);

    expect(onCreateSessionRequested).toHaveBeenCalledTimes(1);
    expect(startNewSession).not.toHaveBeenCalled();
  });

  it('routes new-session URL requests through the overlay callback', async () => {
    const startNewSession = vi.fn();
    const onCreateSessionRequested = vi.fn();
    const workspace = createWorkspace('workspace-empty');
    const session = createSession('session-existing', workspace.id);
    useWorkspaceSessionsMock.mockReturnValue({
      sessions: [session],
      selectedSession: undefined,
      selectedSessionId: undefined,
      selectSession: vi.fn(),
      selectLatestSession: vi.fn(),
      isLoading: false,
      isNewSessionMode: false,
      isPendingNewSessionMode: false,
      requestNewSession: vi.fn(),
      confirmNewSession: vi.fn(),
      cancelNewSession: vi.fn(),
      startNewSession,
    });

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    queryClient.setQueryData(['taskAttempt', workspace.id], workspace);

    render(
      <MemoryRouter initialEntries={[`/?newSession=1`]}>
        <QueryClientProvider client={queryClient}>
          <KanbanSessionConversationView
            workspaceId={workspace.id}
            interactive={true}
            showSessionSelector={true}
            onCreateSessionRequested={onCreateSessionRequested}
          />
        </QueryClientProvider>
      </MemoryRouter>
    );

    expect(onCreateSessionRequested).toHaveBeenCalledTimes(1);
    expect(startNewSession).not.toHaveBeenCalled();
  });

  it('renders the existing session shell on workspace routes without an explicit session selection', () => {
    const startNewSession = vi.fn();
    const selectSession = vi.fn();
    useWorkspaceSessionsMock.mockReturnValue({
      sessions: [
        {
          id: 'session-existing',
          workspace_id: 'workspace-empty',
          taskId: 'task-1',
          name: 'Existing Session',
          status: 'todo',
          executor: null,
          created_at: '2026-03-24T00:00:00.000Z',
          updated_at: '2026-03-24T00:00:00.000Z',
          firstPrompt: null,
          isRunning: false,
          queueStatus: null,
          displayName: 'Existing Session',
          workspaceName: 'Workspace Empty',
          workspaceBranch: 'main',
          statusLabel: 'Todo',
          continuityMode: 'new_session',
          continuityLabel: 'New session',
        },
      ],
      selectedSession: undefined,
      selectedSessionId: undefined,
      selectSession,
      selectLatestSession: vi.fn(),
      isLoading: false,
      isNewSessionMode: false,
      isPendingNewSessionMode: false,
      requestNewSession: vi.fn(),
      confirmNewSession: vi.fn(),
      cancelNewSession: vi.fn(),
      startNewSession,
    });

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    queryClient.setQueryData(['taskAttempt', 'workspace-empty'], {
      ...createWorkspace('workspace-empty'),
      task_id: null,
    });

    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <KanbanSessionConversationView
            workspaceId="workspace-empty"
            interactive={true}
            showSessionSelector={true}
          />
        </QueryClientProvider>
      </MemoryRouter>
    );

    expect(useWorkspaceSessionsMock).toHaveBeenCalledWith(
      'workspace-empty',
      expect.objectContaining({
        autoSelectFirstSession: true,
      })
    );
    expect(screen.getByTestId('virtualized-list')).toHaveTextContent(
      'workspace-empty:none'
    );
    expect(screen.getByTestId('entries-provider')).toHaveAttribute(
      'data-runtime-key',
      'workspace-empty:no-session'
    );
    expect(screen.getByTestId('follow-up-section')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '新建会话' })
    ).not.toBeInTheDocument();
    expect(selectSession).not.toHaveBeenCalled();
    expect(startNewSession).not.toHaveBeenCalled();
  });

  it('renders immediately from shared query cache data', () => {
    useWorkspaceSessionsMock.mockReturnValue({
      sessions: [],
      selectedSession: undefined,
      selectedSessionId: undefined,
      selectSession: vi.fn(),
      selectLatestSession: vi.fn(),
      isLoading: false,
      isNewSessionMode: false,
      isPendingNewSessionMode: false,
      requestNewSession: vi.fn(),
      confirmNewSession: vi.fn(),
      cancelNewSession: vi.fn(),
      startNewSession: vi.fn(),
    });

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    const workspace = createWorkspace('workspace-1');
    const session = createSession('session-1', workspace.id);
    queryClient.setQueryData(['taskAttempt', workspace.id], workspace);
    queryClient.setQueryData(['session', session.id], session);

    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <KanbanSessionConversationView
            workspaceId={workspace.id}
            sessionId={session.id}
          />
        </QueryClientProvider>
      </MemoryRouter>
    );

    expect(screen.getByTestId('virtualized-list')).toHaveTextContent(
      'workspace-1:session-1'
    );
    expect(screen.getByTestId('entries-provider')).toHaveAttribute(
      'data-runtime-key',
      'workspace-1:session-1'
    );
    expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument();
  });

  it('shows the loader instead of fabricating a conversation before detail queries resolve', () => {
    useWorkspaceSessionsMock.mockReturnValue({
      sessions: [],
      selectedSession: undefined,
      selectedSessionId: undefined,
      selectSession: vi.fn(),
      selectLatestSession: vi.fn(),
      isLoading: false,
      isNewSessionMode: false,
      isPendingNewSessionMode: false,
      requestNewSession: vi.fn(),
      confirmNewSession: vi.fn(),
      cancelNewSession: vi.fn(),
      startNewSession: vi.fn(),
    });

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <KanbanSessionConversationView
            workspaceId="workspace-2"
            sessionId="session-2"
          />
        </QueryClientProvider>
      </MemoryRouter>
    );

    expect(screen.queryByTestId('virtualized-list')).not.toBeInTheDocument();
    expect(screen.getByText(/加载/)).toBeInTheDocument();
  });

  it('does not mount the interactive shell while session details are still loading', () => {
    useWorkspaceSessionsMock.mockReturnValue({
      sessions: [],
      selectedSession: undefined,
      selectedSessionId: undefined,
      selectSession: vi.fn(),
      selectLatestSession: vi.fn(),
      isLoading: false,
      isNewSessionMode: false,
      isPendingNewSessionMode: false,
      requestNewSession: vi.fn(),
      confirmNewSession: vi.fn(),
      cancelNewSession: vi.fn(),
      startNewSession: vi.fn(),
    });

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    queryClient.setQueryData(
      ['taskAttempt', 'workspace-2'],
      createWorkspace('workspace-2')
    );

    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <KanbanSessionConversationView
            workspaceId="workspace-2"
            sessionId="session-2"
            interactive={true}
            showSessionSelector={true}
          />
        </QueryClientProvider>
      </MemoryRouter>
    );

    expect(screen.queryByTestId('virtualized-list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('follow-up-section')).not.toBeInTheDocument();
    expect(screen.getByText(/加载/)).toBeInTheDocument();
  });

  it('does not fabricate a conversation when the requested session was deleted', async () => {
    useWorkspaceSessionsMock.mockReturnValue({
      sessions: [],
      selectedSession: undefined,
      selectedSessionId: undefined,
      selectSession: vi.fn(),
      selectLatestSession: vi.fn(),
      isLoading: false,
      isNewSessionMode: false,
      isPendingNewSessionMode: false,
      requestNewSession: vi.fn(),
      confirmNewSession: vi.fn(),
      cancelNewSession: vi.fn(),
      startNewSession: vi.fn(),
    });
    sessionsGetByIdMock.mockRejectedValueOnce(new Error('Session not found'));

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    queryClient.setQueryData(
      ['taskAttempt', 'workspace-2'],
      createWorkspace('workspace-2')
    );

    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <KanbanSessionConversationView
            workspaceId="workspace-2"
            sessionId="deleted-session"
            interactive={true}
          />
        </QueryClientProvider>
      </MemoryRouter>
    );

    expect(
      await screen.findByRole('button', { name: '新建会话' })
    ).toBeInTheDocument();
    expect(screen.queryByTestId('virtualized-list')).not.toBeInTheDocument();
  });

  it('moves a session between placement slots without remounting the conversation tree', () => {
    useWorkspaceSessionsMock.mockReturnValue({
      sessions: [],
      selectedSession: undefined,
      selectedSessionId: undefined,
      selectSession: vi.fn(),
      selectLatestSession: vi.fn(),
      isLoading: false,
      isNewSessionMode: false,
      isPendingNewSessionMode: false,
      requestNewSession: vi.fn(),
      confirmNewSession: vi.fn(),
      cancelNewSession: vi.fn(),
      startNewSession: vi.fn(),
    });

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    const workspace = createWorkspace('workspace-1');
    const session = createSession('session-1', workspace.id);
    queryClient.setQueryData(['taskAttempt', workspace.id], workspace);
    queryClient.setQueryData(['session', session.id], session);

    function PlacementHarness({
      placement,
    }: {
      placement: 'monitor' | 'right';
    }) {
      return (
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <KanbanSessionConversationPlacementProvider>
              {placement === 'monitor' ? (
                <div data-testid="monitor-slot">
                  <KanbanSessionConversationView
                    workspaceId={workspace.id}
                    sessionId={session.id}
                  />
                </div>
              ) : (
                <div data-testid="right-slot">
                  <KanbanSessionConversationView
                    workspaceId={workspace.id}
                    sessionId={session.id}
                    interactive={true}
                    showSessionSelector={true}
                  />
                </div>
              )}
            </KanbanSessionConversationPlacementProvider>
          </QueryClientProvider>
        </MemoryRouter>
      );
    }

    const { rerender } = render(<PlacementHarness placement="monitor" />);
    const originalConversationNode = screen.getByTestId('virtualized-list');

    rerender(<PlacementHarness placement="right" />);

    expect(screen.getByTestId('virtualized-list')).toBe(
      originalConversationNode
    );
    expect(screen.getByTestId('right-slot')).toContainElement(
      originalConversationNode
    );
  });

  it('reuses the same conversation tree when a workspace-route session moves into monitor placement', () => {
    const workspace = createWorkspace('workspace-1');
    const session = createSession('session-1', workspace.id);

    useWorkspaceSessionsMock.mockReturnValue({
      sessions: [session],
      selectedSession: session,
      selectedSessionId: session.id,
      selectSession: vi.fn(),
      selectLatestSession: vi.fn(),
      isLoading: false,
      isNewSessionMode: false,
      isPendingNewSessionMode: false,
      requestNewSession: vi.fn(),
      confirmNewSession: vi.fn(),
      cancelNewSession: vi.fn(),
      startNewSession: vi.fn(),
    });

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    queryClient.setQueryData(['taskAttempt', workspace.id], workspace);
    queryClient.setQueryData(['session', session.id], session);

    function PlacementHarness({
      placement,
    }: {
      placement: 'workspace-route' | 'monitor';
    }) {
      return (
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <KanbanSessionConversationPlacementProvider>
              {placement === 'workspace-route' ? (
                <div data-testid="right-slot">
                  <KanbanSessionConversationView
                    workspaceId={workspace.id}
                    interactive={true}
                    showSessionSelector={true}
                  />
                </div>
              ) : (
                <div data-testid="monitor-slot">
                  <KanbanSessionConversationView
                    workspaceId={workspace.id}
                    sessionId={session.id}
                  />
                </div>
              )}
            </KanbanSessionConversationPlacementProvider>
          </QueryClientProvider>
        </MemoryRouter>
      );
    }

    const { rerender } = render(
      <PlacementHarness placement="workspace-route" />
    );
    const originalConversationNode = screen.getByTestId('virtualized-list');

    expect(originalConversationNode).toHaveTextContent(
      'workspace-1:session-1'
    );

    rerender(<PlacementHarness placement="monitor" />);

    expect(screen.getByTestId('virtualized-list')).toBe(
      originalConversationNode
    );
    expect(screen.getByTestId('monitor-slot')).toContainElement(
      originalConversationNode
    );
  });
});
