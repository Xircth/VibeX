import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitBranch, Workspace } from 'shared/types';
import { ConfirmDialog } from '@/components/dialogs/shared/ConfirmDialog';
import { attemptsApi } from '@/lib/api';
import { useFileTreeStore } from '@/stores/useFileTreeStore';
import { useLayoutStore } from '@/stores/useLayoutStore';
import type { WorkspaceWithSession } from '@/types/attempt';
import { WorktreeSelector } from './WorktreeSelector';

const harness = vi.hoisted(() => ({
  activeWorktreeId: 'root-1' as string | null,
  setActiveWorktree: vi.fn(),
  activateExecutionSession: vi.fn(),
  repos: [] as Array<{
    id: string;
    name: string;
    path: string;
    default_target_branch: string | null;
  }>,
  branches: [] as GitBranch[],
  worktrees: [] as Workspace[],
}));

vi.mock('@/contexts/ProjectContext', () => ({
  useProject: () => ({
    projectId: 'project-1',
    project: { id: 'project-1', name: 'VibeX', is_git: true },
  }),
}));

vi.mock('@/contexts/WorktreeContext', () => ({
  useWorktree: () => ({
    activeWorktreeId: harness.activeWorktreeId,
    setActiveWorktree: harness.setActiveWorktree,
  }),
}));

vi.mock('@/contexts/KanbanSessionContext', () => ({
  useKanbanSessionContext: () => ({
    activateExecutionSession: harness.activateExecutionSession,
  }),
}));

vi.mock('@/hooks', () => ({
  useProjectRepos: () => ({ data: harness.repos }),
}));

vi.mock('@/hooks/useProjectWorktrees', () => ({
  useProjectWorktrees: () => ({
    worktrees: harness.worktrees.map((workspace) => ({ workspace })),
    isLoading: false,
  }),
}));

vi.mock('@/hooks/useRepoBranches', () => ({
  useRepoBranches: () => ({ data: harness.branches }),
}));

vi.mock('@/hooks/useTaskAttempt', () => ({
  useTaskAttempt: (id?: string) => ({
    data: harness.worktrees.find((workspace) => workspace.id === id) ?? null,
  }),
}));

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    attemptsApi: {
      ...actual.attemptsApi,
      checkoutBranch: vi.fn(),
      getWithSession: vi.fn(),
      get: vi.fn(),
    },
  };
});

vi.mock('@/components/dialogs/shared/ConfirmDialog', () => ({
  ConfirmDialog: {
    show: vi.fn(),
  },
}));

function workspace(overrides: Partial<Workspace>): Workspace {
  return {
    id: 'root-1',
    project_id: 'project-1',
    task_id: 'task-root',
    parent_workspace_id: null,
    container_ref: 'C:/repo',
    branch: 'dev',
    use_worktree: false,
    agent_working_dir: null,
    setup_completed_at: null,
    created_at: '2026-10-24T00:00:00.000Z',
    updated_at: '2026-10-24T00:00:00.000Z',
    archived: false,
    pinned: false,
    name: null,
    ...overrides,
  };
}

function branch(overrides: Partial<GitBranch>): GitBranch {
  return {
    name: 'dev',
    is_current: false,
    is_remote: false,
    is_worktree: false,
    worktree_path: null,
    last_commit_date: new Date('2026-10-24T00:00:00.000Z'),
    ...overrides,
  };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

function renderSelector() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter
        initialEntries={['/local-projects/project-1/workspaces/root-1']}
      >
        <LocationProbe />
        <Routes>
          <Route
            path="/local-projects/:projectId/workspaces/:workspaceId/sessions/:sessionId"
            element={<WorktreeSelector />}
          />
          <Route
            path="/local-projects/:projectId/workspaces/:workspaceId"
            element={<WorktreeSelector />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
  return { ...view, queryClient };
}

beforeEach(() => {
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => undefined;
    Element.prototype.releasePointerCapture = () => undefined;
  }
  Element.prototype.scrollIntoView = () => undefined;

  harness.activeWorktreeId = 'root-1';
  harness.setActiveWorktree.mockReset();
  harness.activateExecutionSession.mockReset();
  harness.repos = [];
  harness.branches = [];
  harness.worktrees = [];
  useFileTreeStore.setState({
    rootPath: 'C:/old',
    selectedFilePath: 'C:/old/file.ts',
    diffFilePath: 'C:/old/diff.ts',
  });
  useLayoutStore.getState().setActiveTab('kanban');
  vi.mocked(attemptsApi.checkoutBranch).mockReset();
  vi.mocked(attemptsApi.getWithSession).mockReset();
  vi.mocked(attemptsApi.getWithSession).mockImplementation(async (id) => {
    const found = harness.worktrees.find((item) => item.id === id);
    return {
      ...(found ?? workspace({ id })),
      session: undefined,
    };
  });
  vi.mocked(ConfirmDialog.show).mockReset();
});

describe('WorktreeSelector', () => {
  it('caps the list and switches workspaces without checking out', async () => {
    const user = userEvent.setup();
    const root = workspace({ id: 'root-1', branch: 'dev' });
    const worktree = workspace({
      id: 'wt-1',
      task_id: 'task-wt',
      branch: 'feat/next',
      use_worktree: true,
      container_ref: 'C:/wt/feat',
    });
    harness.worktrees = [worktree, root];

    renderSelector();
    await user.click(screen.getByRole('button', { name: '选择工作区' }));

    expect(screen.queryByText('Kanban overview')).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '工作区' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '分支' })).toBeInTheDocument();
    expect(screen.getByTestId('workspace-switcher-list')).toHaveClass(
      'max-h-72'
    );

    const list = screen.getByTestId('workspace-switcher-list');
    const items = within(list).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('dev'),
      expect.stringContaining('feat/next'),
    ]);

    await user.click(
      within(list).getByRole('menuitem', { name: /feat\/next/ })
    );

    expect(harness.setActiveWorktree).toHaveBeenCalledWith('wt-1', 'task-wt');
    expect(screen.getByTestId('location')).toHaveTextContent(
      '/local-projects/project-1/workspaces/wt-1'
    );
    expect(attemptsApi.checkoutBranch).not.toHaveBeenCalled();
    expect(ConfirmDialog.show).not.toHaveBeenCalled();
    expect(useFileTreeStore.getState().rootPath).toBe('C:/wt/feat');
    expect(useFileTreeStore.getState().selectedFilePath).toBeNull();
    expect(useFileTreeStore.getState().diffFilePath).toBeNull();
    expect(useLayoutStore.getState().activeTab).toBe('workspace');
  });

  it('opens the cached session in the same click', async () => {
    const user = userEvent.setup();
    const root = workspace({ id: 'root-1', branch: 'dev' });
    const worktree = workspace({
      id: 'wt-1',
      task_id: 'task-wt',
      branch: 'feat/next',
      use_worktree: true,
      container_ref: 'C:/wt/feat',
    });
    harness.worktrees = [root, worktree];
    vi.mocked(attemptsApi.getWithSession).mockResolvedValue({
      ...worktree,
      session: { id: 'session-9' },
    } as WorkspaceWithSession);
    const { queryClient } = renderSelector();
    queryClient.setQueryData<WorkspaceWithSession>(
      ['taskAttemptWithSession', 'wt-1'],
      {
        ...worktree,
        session: { id: 'session-9' },
      } as WorkspaceWithSession
    );

    await user.click(screen.getByRole('button', { name: '选择工作区' }));
    await user.click(screen.getByRole('menuitem', { name: /feat\/next/ }));

    expect(harness.activateExecutionSession).toHaveBeenCalledWith({
      sessionId: 'session-9',
      workspaceId: 'wt-1',
    });
    expect(screen.getByTestId('location')).toHaveTextContent(
      '/local-projects/project-1/workspaces/wt-1/sessions/session-9'
    );
  });

  it('activates the latest session from cached workspace session summaries on click', async () => {
    const user = userEvent.setup();
    const root = workspace({ id: 'root-1', branch: 'dev' });
    const worktree = workspace({
      id: 'wt-1',
      task_id: 'task-wt',
      branch: 'feat/next',
      use_worktree: true,
      container_ref: 'C:/wt/feat',
    });
    harness.worktrees = [root, worktree];
    const { queryClient } = renderSelector();
    queryClient.setQueryData(
      ['workspaceSessions', 'wt-1', 'summaries'],
      [
        {
          id: 'session-from-summary',
          workspace_id: 'wt-1',
          task_id: 'task-wt',
          name: 'Summary Session',
          first_prompt: 'Fix workspace switcher',
          display_name: 'Summary Session',
          status: 'inprogress',
          executor: 'CLAUDE_CODE',
          agent_id: null,
          workspace_branch: 'feat/next',
          workspace_name: null,
          created_at: '2026-10-24T00:00:00.000Z',
          updated_at: '2026-10-24T00:00:00.000Z',
        },
      ]
    );

    await user.click(screen.getByRole('button', { name: '选择工作区' }));
    await user.click(screen.getByRole('menuitem', { name: /feat\/next/ }));

    expect(harness.activateExecutionSession).toHaveBeenCalledWith({
      sessionId: 'session-from-summary',
      workspaceId: 'wt-1',
    });
    expect(screen.getByTestId('location')).toHaveTextContent(
      '/local-projects/project-1/workspaces/wt-1/sessions/session-from-summary'
    );
    expect(
      queryClient.getQueryData<WorkspaceWithSession>([
        'taskAttemptWithSession',
        'wt-1',
      ])?.session?.id
    ).toBe('session-from-summary');
  });

  it('optimistically updates repoBranches when checking out a branch in the main directory', async () => {
    const user = userEvent.setup();
    const root = workspace({
      id: 'root-1',
      branch: 'dev',
      use_worktree: false,
    });
    harness.activeWorktreeId = 'root-1';
    harness.worktrees = [root];
    harness.repos = [
      {
        id: 'repo-1',
        name: 'vibex',
        path: 'C:/repo',
        default_target_branch: 'dev',
      },
    ];
    harness.branches = [
      branch({ name: 'dev', is_current: true }),
      branch({ name: 'feat/local', is_current: false }),
    ];
    vi.mocked(ConfirmDialog.show).mockResolvedValueOnce('confirmed');
    vi.mocked(attemptsApi.checkoutBranch).mockResolvedValueOnce(undefined);

    const { queryClient } = renderSelector();
    queryClient.setQueryData(['repoBranches', 'repo-1'], harness.branches);

    await user.click(screen.getByRole('button', { name: '选择工作区' }));
    await user.click(screen.getByRole('radio', { name: '分支' }));
    await user.click(screen.getByRole('menuitem', { name: /feat\/local/ }));

    await waitFor(() =>
      expect(attemptsApi.checkoutBranch).toHaveBeenCalledWith(
        'root-1',
        'repo-1',
        'feat/local'
      )
    );
    const updatedBranches = queryClient.getQueryData<GitBranch[]>([
      'repoBranches',
      'repo-1',
    ]);
    expect(updatedBranches?.find((item) => item.is_current)?.name).toBe(
      'feat/local'
    );
  });

  it('pins the main directory branch and confirms other checkouts', async () => {
    const user = userEvent.setup();
    const root = workspace({ id: 'root-1', branch: 'dev' });
    const worktree = workspace({
      id: 'wt-1',
      task_id: 'task-wt',
      branch: 'feat/next',
      use_worktree: true,
      container_ref: 'C:/wt/feat',
    });
    harness.activeWorktreeId = 'wt-1';
    harness.worktrees = [worktree, root];
    harness.repos = [
      {
        id: 'repo-1',
        name: 'vibex',
        path: 'C:/repo',
        default_target_branch: 'dev',
      },
    ];
    harness.branches = [
      branch({ name: 'dev', is_current: true }),
      branch({
        name: 'feat/next',
        is_worktree: true,
        worktree_path: 'C:/wt/feat',
      }),
      branch({ name: 'free/local' }),
      branch({ name: 'origin/dev', is_remote: true }),
    ];
    vi.mocked(attemptsApi.checkoutBranch).mockResolvedValue(undefined);

    renderSelector();
    await user.click(screen.getByRole('button', { name: '选择工作区' }));
    await user.click(screen.getByRole('radio', { name: '分支' }));

    const list = screen.getByTestId('workspace-switcher-list');
    const items = within(list).getAllByRole('menuitem');
    expect(items[0]).toHaveTextContent('dev');
    expect(items[0]).toHaveTextContent('主目录');
    expect(items[1]).toHaveTextContent('feat/next');
    expect(within(list).queryByRole('menuitem', { name: /origin\/dev/ })).toBe(
      null
    );

    await user.click(within(list).getByRole('menuitem', { name: /dev/ }));

    expect(harness.setActiveWorktree).toHaveBeenCalledWith(
      'root-1',
      'task-root'
    );
    expect(screen.getByTestId('location')).toHaveTextContent(
      '/local-projects/project-1/workspaces/root-1'
    );
    expect(ConfirmDialog.show).not.toHaveBeenCalled();
    expect(attemptsApi.checkoutBranch).not.toHaveBeenCalled();

    vi.mocked(ConfirmDialog.show).mockResolvedValueOnce('canceled');
    await user.click(screen.getByRole('button', { name: '选择工作区' }));
    await user.click(screen.getByRole('radio', { name: '分支' }));
    await user.click(screen.getByRole('menuitem', { name: /free\/local/ }));
    await waitFor(() => expect(ConfirmDialog.show).toHaveBeenCalled());
    expect(attemptsApi.checkoutBranch).not.toHaveBeenCalled();

    vi.mocked(ConfirmDialog.show).mockResolvedValueOnce('confirmed');
    await user.click(screen.getByRole('button', { name: '选择工作区' }));
    await user.click(screen.getByRole('radio', { name: '分支' }));
    await user.click(screen.getByRole('menuitem', { name: /free\/local/ }));
    await waitFor(() =>
      expect(attemptsApi.checkoutBranch).toHaveBeenCalledWith(
        'wt-1',
        'repo-1',
        'free/local'
      )
    );
  });
});
