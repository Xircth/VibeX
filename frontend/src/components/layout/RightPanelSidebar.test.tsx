import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { RightPanelSidebar } from './RightPanelSidebar';

const backendCall = vi.hoisted(() => vi.fn());

vi.mock('@/lib/backendTransport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/backendTransport')>()),
  backendCall,
}));

vi.mock('@/contexts/WorktreeContext', () => ({
  useWorktree: () => ({ activeWorktreeId: 'workspace-1' }),
}));

vi.mock('@/contexts/KanbanSessionContext', () => ({
  useKanbanSessionContext: () => ({ visibleRightSession: null }),
}));

vi.mock('@/contexts/ExecutionProcessesContext', () => ({
  ExecutionProcessesProvider: ({ children }: { children: React.ReactNode }) =>
    children,
}));

vi.mock('@/contexts/PanelActionsContext', () => ({
  usePanelActionsContext: () => ({
    openNewTerminal: vi.fn(),
    openDiffPreview: vi.fn(),
    openNotes: vi.fn(),
    openOrFocusPanel: vi.fn(),
    openWebPreview: vi.fn(),
  }),
}));

vi.mock('@/hooks/useTaskAttempt', () => ({
  useTaskAttemptWithSession: () => ({ data: undefined }),
}));

vi.mock('@/hooks/useDevServer', () => ({
  useDevServer: () => ({ runningDevServers: [], devServerProcesses: [] }),
}));

vi.mock('@/hooks/useTauriInspector', () => ({
  useTauriInspector: () => ({
    activate: vi.fn(),
    isActivating: false,
    status: null,
  }),
}));

vi.mock('@/components/dialogs/tasks/ViewProcessesDialog', () => ({
  ViewProcessesDialog: { show: vi.fn() },
}));

describe('RightPanelSidebar', () => {
  it('does not load or render legacy plugin shortcuts', async () => {
    backendCall.mockResolvedValue([
      {
        id: '3f8e2b10-7c44-4c5e-9a11-d2af01000003',
        name: 'Understand Anything',
        enabled: true,
        icon: 'data:image/png;base64,AA==',
        expires_at: null,
      },
    ]);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <RightPanelSidebar />
      </QueryClientProvider>
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(backendCall).not.toHaveBeenCalledWith('plugin_list');
    expect(
      screen.queryByRole('img', { name: 'Understand Anything' })
    ).not.toBeInTheDocument();
  });
});
