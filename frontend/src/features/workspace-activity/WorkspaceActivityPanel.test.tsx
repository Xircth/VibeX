import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { WorkspaceActivityPanel } from './WorkspaceActivityPanel';

const detailMock = vi.hoisted(() => vi.fn());
const backendCallMock = vi.hoisted(() => vi.fn());
const terminalState = vi.hoisted(() => ({
  sessionsByWorkspace: {} as Record<string, unknown[]>,
}));
const executionProcessesState = vi.hoisted(() => ({
  executionProcesses: [] as unknown[],
}));

vi.mock('@/hooks/useKanbanProjectSessions', () => ({
  useKanbanProjectSessions: () => ({
    sessions: [
      {
        id: 's1',
        status: 'inprogress',
        isRunning: true,
        workspace: { id: 'w1' },
        workspaceName: 'main',
        branch: 'main',
        fullName: '会话一',
        name: '会话一',
        executor: 'CLAUDE_CODE',
        agentId: 'CLAUDE_CODE',
        updatedAt: '2026-10-16T00:00:00.000Z',
        isErrored: false,
      },
    ],
  }),
}));

vi.mock('@/hooks/useExecutionProcesses', () => ({
  useExecutionProcesses: () => executionProcessesState,
}));

vi.mock('@/contexts/ProjectContext', () => ({
  useProject: () => ({ projectId: 'p1' }),
  useOptionalProject: () => ({ projectId: 'p1', project: null }),
}));

vi.mock('@/stores/useTerminalStore', () => ({
  useTerminalStore: (select: (state: typeof terminalState) => unknown) =>
    select(terminalState),
}));

vi.mock('@/components/context-menu', () => ({
  useAppContextMenu: () => ({ openSurfaceMenu: vi.fn() }),
}));

vi.mock('@/features/conversation/conversationApi', () => ({
  conversationApi: { detail: detailMock },
}));

vi.mock('@/lib/backendTransport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/backendTransport')>()),
  backendCall: backendCallMock,
}));

describe('WorkspaceActivityPanel', () => {
  beforeEach(() => {
    detailMock.mockReset();
    backendCallMock.mockReset();
    backendCallMock.mockResolvedValue([]);
    terminalState.sessionsByWorkspace = {};
    executionProcessesState.executionProcesses = [];
  });

  it('reuses left-sidebar session rows without the left color marker in a collapsible capped list', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceActivityPanel workspaceId="w1" />
      </QueryClientProvider>
    );

    const sessionRow = container.querySelector('.workspace-session-row');
    expect(sessionRow).toBeTruthy();
    expect(container.querySelector('.workspace-session-row-marker')).toBeNull();

    const list = screen.getByRole('button', { name: /会话一/ }).closest('ul');
    expect(list?.className).toContain('max-h-64');
    expect(list?.className).toContain('overflow-y-auto');

    fireEvent.click(screen.getByRole('button', { name: /Agent 会话进程/ }));

    expect(
      container.querySelector('.workspace-session-row')
    ).not.toBeInTheDocument();
    expect(screen.getByText('后台任务')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Agent 会话进程/ })
    ).toHaveAttribute('aria-expanded', 'false');
  });

  it('renders active background tasks and workspace session errors & warnings on the overview', async () => {
    terminalState.sessionsByWorkspace = {
      w1: [
        {
          tabId: 'acp:t1',
          sessionId: 't1',
          title: 'pnpm run dev',
          shellLabel: 'bash',
          cwd: '/workspace',
          busy: true,
          source: 'acp',
          agentSessionId: 's1',
        },
      ],
    };
    executionProcessesState.executionProcesses = [
      {
        id: 'proc-1',
        session_id: 's1',
        run_reason: 'devserver',
        status: 'running',
      },
      {
        id: 'proc-2',
        session_id: 's1',
        run_reason: 'setupscript',
        status: 'failed',
        exit_code: 1n,
      },
    ];
    detailMock.mockResolvedValue({
      timeline: {
        rows: [
          {
            row_id: 'err-row-1',
            sequence: 1n,
            timestamp: '2026-10-16T00:00:05.000Z',
            row: {
              kind: 'turn_error',
              error: {
                turn_id: 't-1',
                timestamp: '2026-10-16T00:00:05.000Z',
                error: {
                  message: '模型连接中断，请重试',
                  code: 'STREAM_CLOSED',
                  retryable: true,
                  details: null,
                },
              },
            },
          },
        ],
      },
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceActivityPanel workspaceId="w1" sessionId="s1" />
      </QueryClientProvider>
    );

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText('pnpm run dev')).toBeInTheDocument();
    expect(screen.getByText('开发服务器')).toBeInTheDocument();
    expect(await screen.findByText('模型连接中断，请重试')).toBeInTheDocument();
    expect(screen.getByText(/初始化脚本/)).toBeInTheDocument();
  });
});
