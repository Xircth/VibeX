import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { forwardRef, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { Session, TaskWithAttemptStatus, Workspace } from 'shared/types';
import { KanbanSessionConversationView } from './KanbanSessionConversationView';

const { attemptsGetMock, sessionsGetByIdMock, useWorkspaceSessionsMock } =
  vi.hoisted(() => ({
    attemptsGetMock: vi.fn(() => new Promise<Workspace>(() => {})),
    sessionsGetByIdMock: vi.fn(() => new Promise<Session>(() => {})),
    useWorkspaceSessionsMock: vi.fn(() => ({
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
    })),
  }));

vi.mock('@/contexts/ProjectContext', () => ({
  useProject: () => ({ projectId: 'project-1' }),
}));

vi.mock('@/hooks/useWorkspaceSessions', () => ({
  useWorkspaceSessions: useWorkspaceSessionsMock,
  resolveActiveSession: (session: Session | undefined) => session,
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
  EntriesProvider: ({ children }: { children: ReactNode }) => children,
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

describe('KanbanSessionConversationView', () => {
  it('keeps the follow-up shell interactive when a workspace has no existing sessions', () => {
    useWorkspaceSessionsMock.mockReturnValue({
      sessions: [],
      selectedSession: undefined,
      selectedSessionId: undefined,
      selectSession: vi.fn(),
      selectLatestSession: vi.fn(),
      isLoading: false,
      isNewSessionMode: true,
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
            workspaceId="workspace-empty"
            interactive={true}
            showSessionSelector={true}
          />
        </QueryClientProvider>
      </MemoryRouter>
    );

    expect(screen.getByTestId('virtualized-list')).toHaveTextContent(
      'workspace-empty:none'
    );
    expect(screen.getByTestId('follow-up-section')).toBeInTheDocument();
  });

  it('renders immediately from initial Kanban session data', () => {
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

    const workspace: Workspace = {
      id: 'workspace-1',
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

    const session: Session = {
      id: 'session-1',
      workspace_id: 'workspace-1',
      task_id: 'task-1',
      name: 'Session One',
      initial_prompt: null,
      status: 'todo',
      executor: null,
      created_at: '2026-03-24T00:00:00.000Z',
      updated_at: '2026-03-24T00:00:00.000Z',
    };

    const task: TaskWithAttemptStatus = {
      id: 'task-1',
      project_id: 'project-1',
      title: 'Task One',
      description: null,
      status: 'todo',
      parent_workspace_id: null,
      created_at: '2026-03-24T00:00:00.000Z',
      updated_at: '2026-03-24T00:00:00.000Z',
      has_in_progress_attempt: false,
      last_attempt_failed: false,
      executor: 'CLAUDE_CODE',
    };

    render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <KanbanSessionConversationView
            workspaceId={workspace.id}
            sessionId={session.id}
            initialWorkspace={workspace}
            initialSession={session}
            initialTask={task}
          />
        </QueryClientProvider>
      </MemoryRouter>
    );

    expect(screen.getByTestId('virtualized-list')).toHaveTextContent(
      'workspace-1:session-1'
    );
    expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument();
  });

  it('renders conversation shell even before detail queries resolve', () => {
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

    expect(screen.getByTestId('virtualized-list')).toHaveTextContent(
      'workspace-2:session-2'
    );
  });
});
