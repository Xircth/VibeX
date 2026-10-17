import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceActivityPanel } from './WorkspaceActivityPanel';

vi.mock('@/hooks/useKanbanProjectSessions', () => ({
  useKanbanProjectSessions: () => ({
    sessions: [
      {
        id: 's1',
        status: 'active',
        workspace: { id: 'w1' },
        fullName: '会话一',
        isErrored: false,
      },
    ],
  }),
}));

vi.mock('@/hooks/useExecutionProcesses', () => ({
  useExecutionProcesses: () => ({ executionProcesses: [] }),
}));

vi.mock('@/contexts/ProjectContext', () => ({
  useProject: () => ({ projectId: 'p1' }),
}));

vi.mock('@/stores/useTerminalStore', () => ({
  useTerminalStore: (
    select: (state: { sessionsByWorkspace: object }) => unknown
  ) => select({ sessionsByWorkspace: {} }),
}));

vi.mock('@/components/context-menu', () => ({
  useAppContextMenu: () => ({ openSurfaceMenu: vi.fn() }),
}));

vi.mock('@/features/conversation/conversationApi', () => ({
  conversationApi: { detail: vi.fn() },
}));

describe('WorkspaceActivityPanel', () => {
  it('keeps agent sessions in a collapsible capped list', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceActivityPanel workspaceId="w1" />
      </QueryClientProvider>
    );

    expect(screen.getByText('查看会话时序图')).toBeInTheDocument();
    const list = screen.getByRole('button', { name: /会话一/ }).closest('ul');
    expect(list?.className).toContain('max-h-64');
    expect(list?.className).toContain('overflow-y-auto');

    fireEvent.click(screen.getByRole('button', { name: 'Agent 会话进程' }));

    expect(screen.queryByText('查看会话时序图')).not.toBeInTheDocument();
    expect(screen.getByText('后台任务')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Agent 会话进程' })
    ).toHaveAttribute('aria-expanded', 'false');
  });
});
