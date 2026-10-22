import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { RightPanelSidebar } from './RightPanelSidebar';

const backendCall = vi.hoisted(() => vi.fn());
const panelActions = vi.hoisted(() => ({
  openNewTerminal: vi.fn(),
  openDiffPreview: vi.fn(),
  openNotes: vi.fn(),
  openOrFocusPanel: vi.fn(),
  openPluginPanel: vi.fn(),
}));

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

vi.mock('@/contexts/PanelActionsContext', () => ({
  usePanelActionsContext: () => panelActions,
}));

vi.mock('@/hooks/useTaskAttempt', () => ({
  useTaskAttemptWithSession: () => ({ data: undefined }),
}));

vi.mock('@/hooks/useDevServer', () => ({
  useDevServer: () => ({ runningDevServers: [], devServerProcesses: [] }),
}));

const transportEnvironment = vi.hoisted(() => ({
  current: 'desktop' as 'desktop' | 'web' | 'remote-desktop',
}));

vi.mock('@/lib/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transport')>()),
  useBackendTransport: () => ({ environment: transportEnvironment.current }),
}));

describe('RightPanelSidebar', () => {
  beforeEach(() => {
    transportEnvironment.current = 'desktop';
    panelActions.openOrFocusPanel.mockClear();
  });

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

    expect(document.querySelector('.workspace-chrome')).toBeTruthy();
    expect(backendCall).not.toHaveBeenCalledWith('plugin_list');
    expect(
      screen.queryByRole('img', { name: 'Understand Anything' })
    ).not.toBeInTheDocument();
  });

  it('does not hard-code a browser rail button without a plugin contribution', async () => {
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
    });

    expect(
      screen.queryByRole('button', { name: '打开网络预览' })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '打开终端' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '在运行中的 Tauri App 内点选元素' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', {
        name: 'Select elements in the running Tauri App',
      })
    ).not.toBeInTheDocument();
  });

  it('hides plugin-only rail buttons on WebUI', async () => {
    transportEnvironment.current = 'web';
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
    });

    expect(
      screen.queryByRole('button', { name: '打开网络预览' })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '打开终端' })
    ).toBeInTheDocument();
  });

  it('opens session details from the button under the terminal', async () => {
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
    });

    const buttons = screen.getAllByRole('button');
    const terminal = screen.getByRole('button', { name: '打开终端' });
    const details = screen.getByRole('button', { name: '会话详情' });
    expect(buttons.indexOf(details)).toBe(buttons.indexOf(terminal) + 1);

    fireEvent.click(details);
    expect(panelActions.openOrFocusPanel).toHaveBeenCalledWith(
      'session-details',
      '会话详情'
    );
  });

  it('opens processes as a dockview tab instead of a modal dialog', async () => {
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
    });

    const processes = screen.getByRole('button', { name: '执行进程' });
    fireEvent.click(processes);
    expect(panelActions.openOrFocusPanel).toHaveBeenCalledWith(
      'processes',
      '执行进程'
    );
  });
});
